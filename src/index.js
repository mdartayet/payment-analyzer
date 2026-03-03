const express = require('express');
const bodyParser = require('body-parser');
const { format, addDays, isSameMonth, isAfter, startOfDay } = require('date-fns');
const dateFnsTz = require('date-fns-tz');

// Detectar automáticamente qué función usar según la versión de la librería
const convertToZoned = dateFnsTz.toZonedTime || dateFnsTz.utcToZonedTime;

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Guayaquil';

app.use(bodyParser.json());

app.post('/api/analizar-promesa-pago', (req, res) => {
    try {
        let { client_input, valor_exigible, dias_mora } = req.body;

        if (!client_input || valor_exigible === undefined || dias_mora === undefined) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos.' });
        }

        const v_exigible = parseFloat(valor_exigible);
        const d_mora = parseInt(dias_mora);

        // 1. Configurar Fechas con la función detectada
        const now = new Date();
        const fecha_actual_local = convertToZoned(now, TIMEZONE);
        const hoy_solo_fecha = startOfDay(fecha_actual_local);

        // 2. Extraer montos del texto
        const montos_encontrados = client_input.match(/\d+/g) || [];
        const suma_pagos = montos_encontrados.reduce((acc, curr) => acc + parseFloat(curr), 0);

        // Simulación: asumimos pago en 3 días para la validación
        const max_pago_date = addDays(hoy_solo_fecha, 3);
        const max_pago_fecha_str = format(max_pago_date, 'yyyy-MM-dd');

        // 3. Cálculos de Corte
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
            razon_rechazo = 'Propuesta fuera del mes actual.';
        }

        if (suma_pagos < v_exigible) {
            is_acceptable = false;
            razon_rechazo = razon_rechazo ? `${razon_rechazo} Monto insuficiente.` : 'Monto total no cubierto.';
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
        console.error('SERVER FATAL ERROR:', error);
        return res.status(500).json({ error: 'Error interno en cálculos de fecha: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor ejecutándose en puerto ${PORT}`);
});
