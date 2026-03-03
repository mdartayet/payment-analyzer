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
        const pagos = extraerPagosNLP(client_input, fecha_actual);

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
 * Extrae pagos usando chrono-node para NLP
 */
function extraerPagosNLP(client_input, fecha_actual) {
    const pagos = [];

    // Dividir por "y" o comas
    const partes = client_input.replace(/,/g, ' y ').split(' y ');

    for (const parte of partes) {
        const parte_trim = parte.trim();

        // Extraer número (monto)
        const numeros = parte_trim.match(/\d+(?:\.\d+)?/g);
        if (!numeros) continue;

        const monto = parseFloat(numeros[0]);

        // Extraer fecha verbal
        let fecha_verbal = parte_trim
            .replace(/\d+(?:\.\d+)?/g, '')
            .replace(/\$/g, '')
            .replace(/dólares?/g, '')
            .trim();

        // Usar chrono-node para parsear
        let fecha_exacta = null;

        try {
            const resultado_chrono = parseDate(fecha_verbal, fecha_actual.toDate());
            if (resultado_chrono) {
                fecha_exacta = moment(resultado_chrono).tz('America/Guayaquil');
            }
        } catch (e) {
            // Fallback si chrono falla
        }

        // Si chrono no funcionó, usar fallback
        if (!fecha_exacta) {
            fecha_exacta = resolverFechaFallback(fecha_verbal, fecha_actual);
        }

        pagos.push({
            monto: monto,
            fecha_verbal_original: fecha_verbal,
            fecha_exacta: fecha_exacta
        });
    }

    // Ordenar por fecha
    pagos.sort((a, b) => a.fecha_exacta.diff(b.fecha_exacta));

    return pagos;
}

/**
 * Fallback para resolver fechas si chrono falla
 */
function resolverFechaFallback(fecha_verbal, fecha_actual) {
    fecha_verbal = fecha_verbal.toLowerCase().trim();

    // Casos simples
    if (fecha_verbal === 'hoy' || fecha_verbal === 'hoy mismo') {
        return fecha_actual.clone();
    }

    if (fecha_verbal === 'mañana') {
        return fecha_actual.clone().add(1, 'day');
    }

    if (fecha_verbal === 'pasado mañana') {
        return fecha_actual.clone().add(2, 'days');
    }

    // Días de la semana
    const diasSemana = {
        'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3,
        'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6, 'domingo': 0
    };

    for (const [dia, num] of Object.entries(diasSemana)) {
        if (fecha_verbal.includes(dia)) {
            let fecha = fecha_actual.clone();
            const hoy_dia = fecha.day(); // 0 = domingo, 1 = lunes, etc.

            let dias_adelante = (num - hoy_dia + 7) % 7;

            // Si es hoy, ir al próximo
            if (dias_adelante === 0) {
                dias_adelante = 7;
            }

            return fecha.add(dias_adelante, 'days');
        }
    }

    // Si no se puede resolver, retornar fecha actual
    return fecha_actual.clone();
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
