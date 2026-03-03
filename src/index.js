const express = require('express');
const bodyParser = require('body-parser');
const { format, addDays, isSameMonth, parseISO, isAfter, startOfDay } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Guayaquil';

app.use(bodyParser.json());

app.post('/api/analizar-promesa-pago', (req, res) => {
    try {
        let { client_input, valor_exigible, dias_mora } = req.body;

        // Validación y limpieza de datos de entrada
        if (!client_input || valor_exigible === undefined || dias_mora === undefined) {
            return res.status(400).json({ error: 'Faltan parámetros: client_input, valor_exigible y dias_mora son obligatorios.' });
        }

        // Asegurar que los números sean números (evita errores de strings en Postman)
        const v_exigible = parseFloat(valor_exigible);
        const d_mora = parseInt(dias_mora);

        if (isNaN(v_exigible) || isNaN(d_mora)) {
            return res.status(400).json({ error: 'valor_exigible y dias_mora deben ser números válidos.' });
        }

        // 1. Configurar Fechas
        const now = new Date();
        const fecha_actual_local = toZonedTime(now, TIMEZONE);
        const hoy_solo_fecha = startOfDay(fecha_actual_local);

        // 2. Extraer montos del input
        const montos_encontrados = client_input.match(/\d+/g) || [];
        const suma_pagos = montos_encontrados.reduce((acc, curr) => acc + parseFloat(curr), 0);

        // Simulación de fecha de pago (3 días después por defecto si no se detecta otra)
        const max_pago_date = addDays(hoy_solo_fecha, 3);
        const max_pago_fecha_str = format(max_pago_date, 'yyyy-MM-dd');

        // 3. Cálculos
        const dias_para_corte = 30 - d_mora;
        const fecha_corte = addDays(hoy_solo_fecha, dias_para_corte);
        const fecha_corte_str = format(fecha_corte, 'yyyy-MM-dd');

        const hay_nueva_cuota = isAfter(max_pago_date, fecha_corte);
        const faltante = v_exigible - suma_pagos;

        // 4. Validaciones
        let is_acceptable = true;
        let razon_rechazo = null;

        if (!isSameMonth(max_pago_date, hoy_solo_fecha)) {
            is_acceptable = false;
            razon_rechazo = 'Fecha fuera del mes actual.';
        }

        if (suma_pagos < v_exigible) {
            is_acceptable = false;
            razon_rechazo = razon_rechazo ? `${razon_rechazo} Monto insuficiente.` : 'La suma de pagos es menor al valor exigible.';
        }

        return res.json({
            is_acceptable,
            fecha_corte_mes: fecha_corte_str,
            hay_nueva_cuota,
            suma_pagos,
            max_pago_fecha: max_pago_fecha_str,
            faltante: Math.max(0, faltante),
            razon_rechazo
        });

    } catch (error) {
        console.error('SERVER ERROR:', error);
        return res.status(500).json({ error: 'Error interno en el procesamiento de fechas.' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor listo en puerto ${PORT}`);
});
