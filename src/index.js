const express = require('express');
const bodyParser = require('body-parser');
const { format, addDays, isSameMonth, isAfter, startOfDay, isSameDay } = require('date-fns');
const dateFnsTz = require('date-fns-tz');
const chrono = require('chrono-node');

// Detectar función de zona horaria
const convertToZoned = dateFnsTz.toZonedTime || dateFnsTz.utcToZonedTime;

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Guayaquil';

app.use(bodyParser.json());

/**
 * Lógica para manejar el "Día de la semana" (si es hoy, pasar al siguiente)
 */
function refineDate(parsedDate, referenceDate) {
    // Si la fecha parseada es HOY, chrono-node a veces asume que es hoy.
    // Para cobranzas, si hoy es martes y dices "el martes", te refieres al próximo.
    if (isSameDay(parsedDate, referenceDate)) {
        return addDays(parsedDate, 7);
    }
    return parsedDate;
}

app.post('/api/analizar-promesa-pago', (req, res) => {
    try {
        let { client_input, valor_exigible, dias_mora } = req.body;

        if (!client_input || valor_exigible === undefined || dias_mora === undefined) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos.' });
        }

        const v_exigible = parseFloat(valor_exigible);
        const d_mora = parseInt(dias_mora);

        // 1. Configurar Referencia Temporal (Ecuador)
        const now = new Date();
        const fecha_actual_local = convertToZoned(now, TIMEZONE);
        const hoy_solo_fecha = startOfDay(fecha_actual_local);

        // 2. Extraer Montos
        const montos_encontrados = client_input.match(/\d+(\.\d+)?/g) || [];
        const suma_pagos = montos_encontrados.reduce((acc, curr) => acc + parseFloat(curr), 0);

        // 3. Extraer Fechas Abstracciones (NLP)
        // Usamos el locale de español de chrono
        const results = chrono.es.parse(client_input, hoy_solo_fecha);

        let max_pago_date = addDays(hoy_solo_fecha, 1); // Default mañana si no detecta nada

        if (results.length > 0) {
            // Obtener la fecha más lejana encontrada en el texto
            const dates = results.map(r => {
                let d = r.start.date();
                return refineDate(d, hoy_solo_fecha);
            });
            max_pago_date = new Date(Math.max(...dates));
        }

        const max_pago_fecha_str = format(max_pago_date, 'yyyy-MM-dd');

        // 4. Cálculos de Corte
        const dias_para_corte = 30 - d_mora;
        const fecha_corte = addDays(hoy_solo_fecha, dias_para_corte);
        const fecha_corte_str = format(fecha_corte, 'yyyy-MM-dd');

        // Nueva cuota: Si el pago es EN o DESPUÉS de la fecha de corte
        const hay_nueva_cuota = isAfter(max_pago_date, fecha_corte) || isSameDay(max_pago_date, fecha_corte);
        const faltante = v_exigible - suma_pagos;

        // 5. Validaciones de Reglas del Banco
        let is_acceptable = true;
        let razon_rechazo = null;

        // Regla 1: Mes actual
        if (!isSameMonth(max_pago_date, hoy_solo_fecha)) {
            is_acceptable = false;
            razon_rechazo = 'Propuesta fuera del mes actual.';
        }

        // Regla 2: Suma completa
        if (suma_pagos < v_exigible) {
            is_acceptable = false;
            const msgMonto = `Monto insuficiente (faltan $${Math.max(0, faltante).toFixed(2)}).`;
            razon_rechazo = razon_rechazo ? `${razon_rechazo} ${msgMonto}` : msgMonto;
        }

        return res.json({
            is_acceptable,
            fecha_corte_mes: fecha_corte_str,
            hay_nueva_cuota,
            suma_pagos: parseFloat(suma_pagos.toFixed(2)),
            max_pago_fecha: max_pago_fecha_str,
            faltante: Math.max(0, parseFloat(faltante.toFixed(2))),
            razon_rechazo,
            debug: {
                texto_detectado: results.length > 0 ? results.map(r => r.text) : "ninguno",
                fecha_referencia: format(hoy_solo_fecha, 'yyyy-MM-dd')
            }
        });

    } catch (error) {
        console.error('SERVER ERROR:', error);
        return res.status(500).json({ error: 'Error procesando NLP temporal: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Analizador Inteligente v2 listo en puerto ${PORT}`);
});
