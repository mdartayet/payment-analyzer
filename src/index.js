const express = require('express');
const { parseDate } = require('chrono-node');
const moment = require('moment-timezone');

const app = express();
app.use(express.json());

// Configuración de zona horaria
moment.tz.setDefault('America/Guayaquil');

const es = {
    months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    weekdays: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
};

/**
 * Endpoint con pagos_consolidados
 * POST /api/analizar-promesa-pago
 */
app.post('/api/analizar-promesa-pago', (req, res) => {
    try {
        const data = req.body;

        // Inputs
        const client_input = data.client_input ? data.client_input.toLowerCase() : '';
        const valor_exigible = parseFloat(data.valor_exigible) || 0;
        const dias_mora = parseInt(data.dias_mora) || 0;

        // Fecha actual en Ecuador
        const fecha_actual = moment.tz('America/Guayaquil');

        // PASO 1: Calcular fecha de corte
        const dias_hasta_corte = 30 - dias_mora;
        const fecha_corte = fecha_actual.clone().add(dias_hasta_corte, 'days');

        // PASO 2: Último día del mes
        const ultimo_dia_mes = fecha_actual.clone().endOf('month');

        // PASO 3: Extraer pagos con NLP
        const pagos = extraerPagosNLP(client_input, fecha_actual, valor_exigible);

        // PASO 4: Calcular suma
        const suma_pagos = pagos.reduce((sum, p) => sum + p.monto, 0);

        let max_pago_fecha = fecha_actual.clone();
        if (pagos.length > 0) {
            max_pago_fecha = moment.max(pagos.map(p => p.fecha_exacta));
        }

        // PASO 5: Validar prohibiciones
        let is_acceptable = true;
        let razon_rechazo = null;

        // PROHIBICIÓN 1: Fecha fuera del mes
        if (max_pago_fecha.isAfter(ultimo_dia_mes, 'day')) {
            is_acceptable = false;
            razon_rechazo = "fecha_fuera_del_mes";
        }

        // PROHIBICIÓN 2: Suma insuficiente
        if (suma_pagos < valor_exigible) {
            is_acceptable = false;
            razon_rechazo = "suma_no_cubre";
        }

        // PASO 6: Detectar nueva cuota
        const hay_nueva_cuota = max_pago_fecha.isSameOrAfter(fecha_corte, 'day');

        // PASO 7: Construir pagos_consolidados
        const pagos_consolidados = pagos.map((pago, index) => ({
            numero: index + 1,
            monto: pago.monto,
            fecha_verbal_original: pago.fecha_verbal_original,
            fecha_exacta: pago.fecha_exacta.format('YYYY-MM-DD'),
            fecha_texto_resumen: formatearFechaTexto(pago.fecha_exacta),
            es_en_fecha_corte: pago.fecha_exacta.isSame(fecha_corte, 'day'),
            genera_nueva_cuota: pago.fecha_exacta.isSameOrAfter(fecha_corte, 'day')
        }));

        // PASO 8: Construir respuesta
        const respuesta = {
            is_acceptable: is_acceptable,
            fecha_actual: fecha_actual.format('YYYY-MM-DD'),
            fecha_corte_mes: fecha_corte.format('YYYY-MM-DD'),
            hay_nueva_cuota: hay_nueva_cuota,
            suma_pagos: suma_pagos,
            max_pago_fecha: max_pago_fecha.format('YYYY-MM-DD'),
            valor_exigible: valor_exigible,
            faltante: valor_exigible - suma_pagos,
            pagos_consolidados: pagos_consolidados,
            razon_rechazo: razon_rechazo
        };

        res.json(respuesta);

    } catch (error) {
        res.status(500).json({
            error: error.message,
            message: 'Error al procesar la promesa de pago'
        });
    }
});

/**
 * Extrae pagos usando chrono-node para NLP y lógica de negocio expandida
 */
function extraerPagosNLP(client_input, fecha_actual, valor_exigible) {
    const pagos = [];
    let suma_acumulada = 0;

    // Normalizaciones previas del texto
    let texto = client_input.toLowerCase()
        .replace(/,/g, ' y ')
        .replace(/ e /g, ' y ')
        .replace(/ junto con /g, ' y ')
        .replace(/ademas/g, ' y ')
        .replace(/luego/g, ' y ')
        .replace(/despues/g, ' y ')
        .replace(/ahora/g, 'hoy')
        .replace(/manana/g, 'mañana')
        .replace(/sabado/g, 'sábado')
        .replace(/miércoles/g, 'miércoles')
        .replace(/miercoles/g, 'miércoles');

    // Dividir por conectores
    const partes = texto.split(' y ');

    for (const parte of partes) {
        const parte_trim = parte.trim();
        if (!parte_trim) continue;

        // --- LÓGICA DE MONTO ---
        let monto = 0;
        const numeros = parte_trim.match(/\d+(?:\.\d+)?/g);

        if (numeros) {
            monto = parseFloat(numeros[0]);
        } else if (parte_trim.includes('la mitad')) {
            monto = valor_exigible / 2;
        } else if (parte_trim.includes('todo') || parte_trim.includes('total') || parte_trim.includes('completo')) {
            monto = valor_exigible - suma_acumulada;
        } else if (parte_trim.includes('el resto') || parte_trim.includes('saldo') || parte_trim.includes('diferencia') || parte_trim.includes('lo demas')) {
            monto = Math.max(0, valor_exigible - suma_acumulada);
        } else if (parte_trim.includes('una parte')) {
            // Si el cliente dice "una parte", y no hay monto, asumimos balance actual / 2 o $0 para forzar aclaración
            monto = (valor_exigible - suma_acumulada) / 2;
        }

        if (monto <= 0 && !numeros) continue;

        suma_acumulada += monto;

        // --- LÓGICA DE FECHA ---
        let fecha_verbal = parte_trim
            .replace(/\d+(?:\.\d+)?/g, '')
            .replace(/\$/g, '')
            .replace(/dólares?/g, '')
            .replace(/la mitad/g, '')
            .replace(/todo/g, '')
            .replace(/total/g, '')
            .replace(/completo/g, '')
            .replace(/el resto/g, '')
            .replace(/saldo/g, '')
            .replace(/diferencia/g, '')
            .replace(/lo demas/g, '')
            .replace(/una parte/g, '')
            .trim();

        let fecha_exacta = null;

        try {
            const resultado_chrono = parseDate(fecha_verbal, fecha_actual.toDate());
            if (resultado_chrono) {
                fecha_exacta = moment(resultado_chrono).tz('America/Guayaquil');

                // Aplicar lógica de "Próximo [Día]" solo para días de la semana específicos
                // Evitamos aplicar esto a "hoy" o fechas relativas directas
                const v_clean = fecha_verbal.toLowerCase();
                const diasEspeciales = ['lunes', 'martes', 'miércoles', 'miercoles', 'jueves', 'viernes', 'sábado', 'sabado', 'domingo'];
                const contieneDiaLiteral = diasEspeciales.some(d => v_clean.includes(d));

                if (contieneDiaLiteral && isSameDay(fecha_exacta.toDate(), fecha_actual.toDate()) && fecha_verbal.length > 3) {
                    fecha_exacta.add(7, 'days');
                }
            }
        } catch (e) { }

        if (!fecha_exacta) {
            fecha_exacta = resolverFechaFallback(fecha_verbal, fecha_actual);
        }

        pagos.push({
            monto: parseFloat(monto.toFixed(2)),
            fecha_verbal_original: fecha_verbal || 'hoy (asumido)',
            fecha_exacta: fecha_exacta
        });
    }

    pagos.sort((a, b) => a.fecha_exacta.diff(b.fecha_exacta));
    return pagos;
}

/**
 * Motor de resolución de ambigüedades temporales (Business Logic)
 */
function resolverFechaFallback(fecha_verbal, fecha_actual) {
    const v = fecha_verbal.toLowerCase().trim();

    // 1. Relativos Directos
    if (v === 'hoy' || v === 'hoy mismo' || v === 'ahora' || v === 'ya') return fecha_actual.clone();
    if (v.includes('mañana') || v.includes('manana')) return fecha_actual.clone().add(1, 'day');
    if (v.includes('pasado mañana') || v.includes('pasado manana')) return fecha_actual.clone().add(2, 'days');

    // 2. Expresiones de Cobranza
    if (v.includes('quincena')) {
        const dia = fecha_actual.date();
        if (dia < 15) return fecha_actual.clone().date(15);
        if (dia >= 15 && dia < 30) return fecha_actual.clone().endOf('month');
        return fecha_actual.clone().add(1, 'month').date(15);
    }

    if (v.includes('fin de mes') || v.includes('final de mes')) {
        return fecha_actual.clone().endOf('month');
    }

    if (v.includes('ocho dias') || v.includes('8 dias') || v.includes('una semana')) {
        return fecha_actual.clone().add(7, 'days');
    }

    if (v.includes('quince dias') || v.includes('15 dias') || v.includes('dos semanas')) {
        return fecha_actual.clone().add(14, 'days');
    }

    if (v.includes('fin de semana')) {
        let f = fecha_actual.clone();
        while (f.day() !== 6) f.add(1, 'day'); // Buscar próximo sábado
        return f;
    }

    if (v.includes('proxima semana') || v.includes('proximo lunes')) {
        let f = fecha_actual.clone().add(7, 'days');
        while (f.day() !== 1) f.subtract(1, 'day'); // Ajustar al lunes de la sig semana
        return f;
    }

    // 3. Días de la semana
    const diasSemana = {
        'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3,
        'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6, 'domingo': 0
    };

    for (const [dia, num] of Object.entries(diasSemana)) {
        if (v.includes(dia)) {
            let f = fecha_actual.clone();
            const hoy_num = f.day();
            let diff = (num - hoy_num + 7) % 7;
            if (diff === 0) diff = 7; // Si es hoy, proyectar al siguiente
            return f.add(diff, 'days');
        }
    }

    // Default: si no entiende nada, hoy + 1 día para seguridad de la promesa
    return fecha_actual.clone().add(1, 'day');
}

/**
 * Formatea fecha a texto en español para el resumen
 * Ej: "viernes 7 de marzo"
 */
function formatearFechaTexto(fecha) {
    const dia_semana = es.weekdays[fecha.day()];
    const numero_dia = fecha.date();
    const mes = es.months[fecha.month()];

    return `${dia_semana} ${numero_dia} de ${mes}`;
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servicio corriendo en puerto ${PORT}`);
    console.log(`Endpoint: POST /api/analizar-promesa-pago`);
});

module.exports = app;
