const express = require('express');
const chrono = require('chrono-node');
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
 * POST /api/analizar-promesa-pago
 */
app.post('/api/analizar-promesa-pago', (req, res) => {
    try {
        const data = req.body;
        const client_input = data.client_input ? data.client_input.toLowerCase() : '';
        const valor_exigible = parseFloat(data.valor_exigible) || 0;
        const d_mora = parseInt(data.dias_mora) || 0;
        const count_previo = parseInt(data.negativas_consecutivas) || 0;

        const fecha_actual = moment.tz('America/Guayaquil').startOf('day');
        const ultimo_dia_mes = fecha_actual.clone().endOf('month');
        const fecha_corte = fecha_actual.clone().add(30 - d_mora, 'days');

        // PASO PREVIO: Detectar intención negativa explícita
        const frasesNegativas = [
            'no tengo mas', 'no tengo más', 'no voy a pagar', 'no puedo pagar',
            'no tengo dinero', 'no tengo plata', 'no tengo para pagar', 'no tengo como',
            'no tengo cómo', 'imposible', 'no quiero pagar', 'no voy a cancelar',
            'no lo hare', 'no lo haré', 'ya te dije', 'ya te estoy diciendo',
            'no me interesa', 'no puedo mas', 'no puedo más', 'es que no tengo',
            'solo tengo como te indique', 'solo tengo como te indiqué', 'pero ya te dije',
            'no tengo para más', 'no tengo para mas', 'no puedo dar más', 'no puedo dar mas',
            'es todo lo que tengo', 'es todo lo que puedo'
        ];

        const cliente_se_niega = frasesNegativas.some(n => client_input.includes(n));

        // Extraer pagos con el motor robusto CORREGIDO para Español
        const pagos = extraerPagosInteligente(client_input, fecha_actual, valor_exigible);

        const suma_pagos = pagos.reduce((sum, p) => sum + p.monto, 0);
        let max_pago_fecha = fecha_actual.clone();
        if (pagos.length > 0) {
            max_pago_fecha = moment.max(pagos.map(p => p.fecha_exacta));
        }

        // Reglas de Negocio
        let is_acceptable = true;
        let razon_rechazo = null;

        // CALCULAR REGISTRO CONTABLE PARA VALIDACIÓN
        const tiene_registro_fuera_mes = pagos.some(p => {
            const f_reg = calcularFechaRegistro(p.fecha_exacta);
            return f_reg.isAfter(ultimo_dia_mes, 'day');
        });

        if (cliente_se_niega) {
            is_acceptable = false;
            razon_rechazo = "negativa_pago";
        } else if (tiene_registro_fuera_mes) {
            is_acceptable = false;
            razon_rechazo = "fecha_fuera_del_mes";
        } else if (max_pago_fecha.isAfter(ultimo_dia_mes, 'day')) {
            is_acceptable = false;
            razon_rechazo = "fecha_fuera_del_mes";
        } else if (suma_pagos < (valor_exigible - 0.01)) {
            is_acceptable = false;
            razon_rechazo = "suma_no_cubre";
        }

        // Lógica de Negativas Consecutivas
        let negativas_consecutivas = count_previo;
        if (is_acceptable) {
            negativas_consecutivas = 0;
        } else if (razon_rechazo === "negativa_pago") {
            negativas_consecutivas = count_previo + 1;
        }

        const hay_nueva_cuota = max_pago_fecha.isSameOrAfter(fecha_corte, 'day');

        const pagos_consolidados = pagos.map((p, i) => {
            const f_reg = calcularFechaRegistro(p.fecha_exacta);
            return {
                numero: i + 1,
                monto: p.monto,
                fecha_verbal_original: p.fecha_verbal_original,
                fecha_exacta: p.fecha_exacta.format('YYYY-MM-DD'),
                fecha_registro_contable: f_reg.format('YYYY-MM-DD'),
                fecha_texto_resumen: formatearFechaTexto(p.fecha_exacta),
                es_registro_proximo_mes: !f_reg.isSame(p.fecha_exacta, 'month'),
                es_en_fecha_corte: p.fecha_exacta.isSame(fecha_corte, 'day'),
                genera_nueva_cuota: p.fecha_exacta.isSameOrAfter(fecha_corte, 'day')
            };
        });

        res.json({
            is_acceptable,
            fecha_actual: fecha_actual.format('YYYY-MM-DD'),
            fecha_corte_mes: fecha_corte.format('YYYY-MM-DD'),
            hay_nueva_cuota,
            suma_pagos: parseFloat(suma_pagos.toFixed(2)),
            max_pago_fecha: max_pago_fecha.format('YYYY-MM-DD'),
            valor_exigible,
            faltante: Math.max(0, parseFloat((valor_exigible - suma_pagos).toFixed(2))),
            pagos_consolidados,
            razon_rechazo,
            cliente_se_niega,
            negativas_consecutivas
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

function extraerPagosInteligente(input, fecha_ref, total_deuda) {
    const pagos = [];
    let suma_acumulada = 0;

    // Normalizar texto y manejar conectores
    let texto = input.toLowerCase()
        .replace(/[,]| además | ademas | luego | después | despues | e | junto con /g, ' y ')
        .replace(/manana/g, 'mañana')
        .replace(/sabado/g, 'sábado')
        .replace(/miercoles/g, 'miércoles')
        .replace(/[$]|dólares|dolares/g, '');

    const partes = texto.split(' y ');

    for (const parte of partes) {
        let p = parte.trim();
        if (!p) continue;

        // 1. Buscar Fecha por Chrono ESPAÑOL
        const chronoRes = chrono.es.parse(p, fecha_ref.toDate(), { forwardDate: true });
        let fecha_obj = null;
        let fecha_texto_detectado = "";

        if (chronoRes.length > 0) {
            fecha_obj = moment(chronoRes[0].start.date()).tz('America/Guayaquil').startOf('day');
            fecha_texto_detectado = chronoRes[0].text;

            // Lógica para saltar a la próxima semana si el día detectado ya pasó o es hoy
            const diasSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
            const mencionaDiaLiteral = diasSemana.some(d => p.includes(d));

            if (mencionaDiaLiteral && fecha_obj.isSameOrBefore(fecha_ref, 'day') && !p.includes('hoy')) {
                fecha_obj.add(7, 'days');
            }
        }

        // 2. Fallbacks de Fecha (Quincena, Fin de mes, etc.)
        if (!fecha_obj) {
            fecha_obj = resolverFechaFallback(p, fecha_ref);
            // Si el fallback resuelve algo basado en texto, lo ideal es quitarlo del monto
            fecha_texto_detectado = ""; // En fallback no siempre tenemos el texto exacto
        }

        // 3. Extraer Monto Robusto
        let texto_para_monto = p.replace(fecha_texto_detectado, "");

        // Mapeo de palabras de números a dígitos
        const mapaNumeros = {
            'diez mil': '10000', 'cinco mil': '5000', 'cuatro mil': '4000', 'tres mil': '3000', 'dos mil': '2000', 'mil': '1000',
            'novecientos': '900', 'ochocientos': '800', 'setecientos': '700', 'seiscientos': '600', 'quinientos': '500', 'cuatrocientos': '400', 'trescientos': '300', 'doscientos': '200', 'ciento': '100', 'cien': '100',
            'noventa': '90', 'ochenta': '80', 'setenta': '70', 'sesenta': '60', 'cincuenta': '50', 'cuarenta': '40', 'treinta': '30', 'veinte': '20', 'diez': '10'
        };

        for (const [palabra, valor] of Object.entries(mapaNumeros)) {
            texto_para_monto = texto_para_monto.replace(new RegExp('\\b' + palabra + '\\b', 'g'), valor);
        }

        let monto = 0;
        const numMatch = texto_para_monto.match(/\d+(?:\.\d+)?/g);

        if (numMatch) {
            // Sumar todos los números encontrados en esta parte (ej: "mil quinientos" -> "1000 500" -> 1500)
            monto = numMatch.reduce((acc, curr) => acc + parseFloat(curr), 0);
        } else if (p.includes('mitad')) {
            monto = (total_deuda / 2);
        } else if (p.includes('todo') || p.includes('todos') || p.includes('toda') || p.includes('resto') || p.includes('saldo') || p.includes('demas') || p.includes('total') || p.includes('completo')) {
            monto = Math.max(0, total_deuda - suma_acumulada);
        }

        if (monto > 0) {
            suma_acumulada += monto;
            pagos.push({
                monto: parseFloat(monto.toFixed(2)),
                fecha_verbal_original: p,
                fecha_exacta: fecha_obj
            });
        }
    }
    pagos.sort((a, b) => a.fecha_exacta.diff(b.fecha_exacta));
    return pagos;
}

function resolverFechaFallback(v, ref) {
    if (v.includes('hoy')) return ref.clone();
    if (v.includes('mañana')) return ref.clone().add(1, 'day');
    if (v.includes('pasado mañana')) return ref.clone().add(2, 'days');
    if (v.includes('quincena')) return ref.date() < 15 ? ref.clone().date(15) : ref.clone().endOf('month');
    if (v.includes('fin de mes')) return ref.clone().endOf('month');
    if (v.includes('ocho') || v.includes('semana')) return ref.clone().add(7, 'days');
    if (v.includes('quince') || v.includes('15 dias')) return ref.clone().add(14, 'days');

    // Resolución de días de la semana manual si Chrono falla
    const diasDict = { 'lunes': 1, 'martes': 2, 'miércoles': 3, 'jueves': 4, 'viernes': 5, 'sábado': 6, 'domingo': 0 };
    for (const [nombre, diaNum] of Object.entries(diasDict)) {
        if (v.includes(nombre)) {
            let f = ref.clone();
            let diff = (diaNum - f.day() + 7) % 7;
            if (diff === 0) diff = 7;
            return f.add(diff, 'days');
        }
    }

    return ref.clone().add(1, 'day');
}

function formatearFechaTexto(fecha) {
    return `${es.weekdays[fecha.day()]} ${fecha.date()} de ${es.months[fecha.month()]}`;
}

/**
 * Lógica de Ecuador: Pagos en Viernes/Sáb/Dom se registran el Lunes.
 */
function calcularFechaRegistro(fecha) {
    const f = fecha.clone();
    const dia = f.day(); // 0: Dom, 5: Vie, 6: Sáb

    if (dia === 5) return f.add(3, 'days'); // Viernes -> Lunes
    if (dia === 6) return f.add(2, 'days'); // Sábado -> Lunes
    if (dia === 0) return f.add(1, 'day');  // Domingo -> Lunes

    return f;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
