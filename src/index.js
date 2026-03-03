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

        const fecha_actual = moment.tz('America/Guayaquil').startOf('day');
        const ultimo_dia_mes = fecha_actual.clone().endOf('month');
        const fecha_corte = fecha_actual.clone().add(30 - d_mora, 'days');

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

        if (max_pago_fecha.isAfter(ultimo_dia_mes, 'day')) {
            is_acceptable = false;
            razon_rechazo = "fecha_fuera_del_mes";
        } else if (suma_pagos < (valor_exigible - 0.01)) {
            is_acceptable = false;
            razon_rechazo = "suma_no_cubre";
        }

        const hay_nueva_cuota = max_pago_fecha.isSameOrAfter(fecha_corte, 'day');

        const pagos_consolidados = pagos.map((p, i) => ({
            numero: i + 1,
            monto: p.monto,
            fecha_verbal_original: p.fecha_verbal_original,
            fecha_exacta: p.fecha_exacta.format('YYYY-MM-DD'),
            fecha_texto_resumen: formatearFechaTexto(p.fecha_exacta),
            es_en_fecha_corte: p.fecha_exacta.isSame(fecha_corte, 'day'),
            genera_nueva_cuota: p.fecha_exacta.isSameOrAfter(fecha_corte, 'day')
        }));

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
            razon_rechazo
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

function extraerPagosInteligente(input, fecha_ref, total_deuda) {
    const pagos = [];
    let suma_acumulada = 0;

    // Normalizar texto
    let texto = input.toLowerCase()
        .replace(/,/g, ' y ')
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

            // Lógica para saltar a la próxima semana si el día detectado es hoy o ya pasó en la semana actual
            const diasSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
            const mencionaDiaLiteral = diasSemana.some(d => p.includes(d));

            if (mencionaDiaLiteral && fecha_obj.isSameOrBefore(fecha_ref, 'day') && !p.includes('hoy')) {
                fecha_obj.add(7, 'days');
            }
        }

        // 2. Fallbacks de Fecha (Quincena, Fin de mes, etc.)
        if (!fecha_obj) {
            fecha_obj = resolverFechaFallback(p, fecha_ref);
            fecha_texto_detectado = "relativo";
        }

        // 3. Extraer Monto
        let texto_para_monto = p.replace(fecha_texto_detectado, "");
        let monto = 0;
        const numMatch = texto_para_monto.match(/\d+(?:\.\d+)?/g);

        if (numMatch) {
            monto = parseFloat(numMatch[0]);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
