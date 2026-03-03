const express = require('express');
const bodyParser = require('body-parser');
const { format, addDays, isSameMonth, parseISO, isAfter, startOfDay } = require('date-fns');
const { utcToZonedTime, zonedTimeToUtc } = require('date-fns-tz');

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Guayaquil'; // Zona horaria Ecuador

app.use(bodyParser.json());

/**
 * Endpoint para analizar promesas de pago
 */
app.post('/api/analizar-promesa-pago', (req, res) => {
    try {
        const { client_input, valor_exigible, dias_mora } = req.body;

        if (!client_input || valor_exigible === undefined || dias_mora === undefined) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos: client_input, valor_exigible, dias_mora' });
        }

        // 1. Configurar Fechas (Zona Horaria Ecuador)
        const now = new Date();
        const fecha_actual_local = utcToZonedTime(now, TIMEZONE);
        const hoy_solo_fecha = startOfDay(fecha_actual_local);

        // 2. Extraer montos y fechas del client_input (Lógica simple para demostración)
        // En un caso real aquí usarías un modelo de lenguaje o regex más complejo.
        // Simulamos la extracción:
        const montos_encontrados = client_input.match(/\d+/g) || [];
        const suma_pagos = montos_encontrados.reduce((acc, curr) => acc + parseFloat(curr), 0);

        // Simulamos fechas: Para este ejemplo, asumiremos que "hoy" es la fecha propuesta
        // En producción, aquí integraríamos una IA para parsear "el jueves" a una fecha real.
        const max_pago_fecha = format(addDays(fecha_actual_local, 3), 'yyyy-MM-dd'); // Simulado: 3 días después
        const max_pago_date = parseISO(max_pago_fecha);

        // 3. Cálculos automáticos
        const dias_para_corte = 30 - dias_mora;
        const fecha_corte = addDays(fecha_actual_local, dias_para_corte);
        const fecha_corte_str = format(fecha_corte, 'yyyy-MM-dd');

        const hay_nueva_cuota = isAfter(max_pago_date, fecha_corte) || max_pago_fecha === fecha_corte_str;
        const faltante = valor_exigible - suma_pagos;

        // 4. Validaciones de prohibición
        let is_acceptable = true;
        let razon_rechazo = null;

        // Prohibición 1: Fecha fuera del mes actual
        if (!isSameMonth(max_pago_date, fecha_actual_local)) {
            is_acceptable = false;
            razon_rechazo = 'La fecha de pago propuesta está fuera del mes actual.';
        }

        // Prohibición 2: Suma menor al valor exigible
        if (suma_pagos < valor_exigible) {
            is_acceptable = false;
            razon_rechazo = razon_rechazo ? `${razon_rechazo} Además, la suma de los pagos es menor al valor adeudado.` : 'La suma propuesta es menor al valor exigible.';
        }

        // 5. Respuesta JSON
        const response = {
            is_acceptable,
            fecha_corte_mes: fecha_corte_str,
            hay_nueva_cuota,
            suma_pagos,
            max_pago_fecha,
            faltante: Math.max(0, faltante),
            razon_rechazo
        };

        return res.json(response);

    } catch (error) {
        console.error('Error procesando la solicitud:', error);
        return res.status(500).json({ error: 'Error interno al procesar el análisis de pago' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor de Análisis de Pagos corriendo en http://localhost:${PORT}`);
    console.log(`🌍 Zona Horaria configurada: ${TIMEZONE}`);
});
