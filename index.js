const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();

// --- CONFIGURACIÓN DE MIDDLEWARES (CON LÍMITE AMPLIADO PARA FOTOS) ---
app.use(cors()); // Permite que React hable con Node
app.use(express.json({ limit: '50mb' })); // Permite JSONs grandes con fotos en Base64
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- CONEXIÓN A LA BASE DE DATOS (MIGRADA A PRODUCCIÓN) ---
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'logwork_pro',
    port: process.env.DB_PORT || 3306
});

db.connect(err => {
    if (err) {
        console.error("❌ ERROR AL CONECTAR DB EN LA NUBE: " + err.message);
    } else {
        console.log("✅ BASE DE DATOS REMOTA CONECTADA CORRECTAMENTE");
    }
});

// --- RUTAS DE LA API ---

// 1. LOGIN (Verifica usuario y devuelve el objeto user)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const sql = "SELECT id, name, role FROM users WHERE username = ? AND password = ?";
    
    db.query(sql, [username, password], (err, results) => {
        if (err) return res.status(500).json({ error: "Error en el servidor" });
        
        if (results.length > 0) {
            res.json({ success: true, user: results[0] });
        } else {
            res.status(401).json({ success: false, message: "Usuario o contraseña incorrectos" });
        }
    });
});

// 2. OBTENER MÁQUINAS DE UN SOLO OPERADOR
app.get('/api/operator/machines/:userId', (req, res) => {
    const { userId } = req.params;

    const sql = `
        SELECT 
            id as machine_id, 
            name as machine_name, 
            total_hours, 
            last_maintenance,
            total_fuel_consumed,
            (total_hours - last_maintenance) as hours_since_maint
        FROM machines 
        WHERE client_id = ?
    `;

    db.query(sql, [userId], (err, results) => {
        if (err) {
            console.error("❌ Error en SQL Operador:", err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// 3. REGISTRAR REPORTE EN LA TABLA REAL MAINTENANCE_HISTORY
app.post('/api/operator/report-issue', (req, res) => {
    const { 
        machine_id, 
        new_hours,         
        fuel_charged, 
        performance,
        failure_comment,   
        photo1,
        photo2,
        photo3
    } = req.body;
    
    const finalComment = `[DIÉSEL CARGADO: ${fuel_charged} Lts] [RENDIMIENTO DEL TURNO: ${performance.toFixed(2)} L/h] | Observaciones: ${failure_comment || 'Turno normal sin novedades.'}`;
    
    const sqlReport = `
        INSERT INTO maintenance_history 
        (machine_id, maintenance_type, hours_at_maintenance, comments, photo_1, photo_2, photo_3) 
        VALUES (?, 'Reporte de Turno / Combustible', ?, ?, ?, ?, ?)
    `;
    
    db.query(sqlReport, [machine_id, new_hours, finalComment, photo1 || null, photo2 || null, photo3 || null], (err, result) => {
        if (err) {
            console.error("❌ Error al insertar en maintenance_history:", err);
            return res.status(500).json({ error: err.message });
        }
        
        const sqlMachine = "UPDATE machines SET total_hours = ?, total_fuel_consumed = total_fuel_consumed + ? WHERE id = ?";
        
        db.query(sqlMachine, [new_hours, fuel_charged || 0, machine_id], (errMachine) => {
            if (errMachine) {
                console.error("❌ Error al actualizar tabla machines:", errMachine);
                return res.status(500).json({ error: errMachine.message });
            }
            
            res.json({ success: true, message: "Turno sincronizado correctamente en el historial." });
        });
    });
});

// 4. ACTUALIZAR HORÓMETRO (Ruta directa de fallback)
app.put('/api/operator/machines/update-hours/:id', (req, res) => {
    const { id } = req.params;
    const { new_hours } = req.body;

    const sql = "UPDATE machines SET total_hours = ? WHERE id = ?";
    
    db.query(sql, [new_hours, id], (err, result) => {
        if (err) {
            console.error("❌ Error al actualizar horas:", err);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: "Horómetro actualizado" });
    });
});

// 5. FALLAS CRÍTICAS PENDIENTES (Para el Admin)
app.get('/api/admin/mechanical-issues', (req, res) => {
    const sql = `
        SELECT 
            i.id,
            m.name as machine_name, 
            u.name as operator_name, 
            i.description, 
            i.severity, 
            i.status,
            i.created_at
        FROM mechanical_issues i
        JOIN machines m ON i.machine_id = m.id
        JOIN users u ON i.operator_id = u.id
        WHERE i.status = 'pendiente'
        ORDER BY i.created_at DESC
    `;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 6. OBTENER RESUMEN DE FLOTA (Para las tarjetas del Admin)
app.get('/api/admin/clients-summary', (req, res) => {
    const sql = `
        SELECT 
            m.id as machine_id, 
            u.id as client_id,
            u.name as client_name, 
            m.name as machine_name, 
            m.total_hours,
            m.serial_number,
            m.last_maintenance,
            (m.total_hours - m.last_maintenance) as hours_since_maint
        FROM machines m
        LEFT JOIN users u ON m.client_id = u.id
    `;
    db.query(sql, (err, results) => {
        if (err) {
            console.error("❌ Error en SQL summary:", err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// 7. OBTENER TODOS LOS USUARIOS (Excepto admins)
app.get('/api/admin/users', (req, res) => {
    const sql = "SELECT id, name, username, role FROM users WHERE role != 'admin'";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 8. CREAR NUEVO USUARIO
app.post('/api/admin/users', (req, res) => {
    const { username, password, name, role } = req.body;
    
    if (!username || !password || !name) {
        return res.status(400).json({ error: "Faltan datos obligatorios" });
    }

    const sql = "INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)";
    db.query(sql, [username, password, name, role || 'operador'], (err, result) => {
        if (err) return res.status(500).json({ error: "Error: El usuario ya existe o fallo SQL" });
        res.json({ success: true, message: "Usuario creado" });
    });
});

// 9. ACTUALIZAR USUARIO (OPERADOR)
app.post('/api/admin/users/update', (req, res) => {
    const { id, name, username, password } = req.body;
    let sql;
    let params;

    if (password && password.trim() !== "") {
        sql = "UPDATE users SET name = ?, username = ?, password = ? WHERE id = ?";
        params = [name, username, password, id];
    } else {
        sql = "UPDATE users SET name = ?, username = ? WHERE id = ?";
        params = [name, username, id];
    }

    db.query(sql, params, (err, result) => {
        if (err) return res.status(500).json({ error: "Error al actualizar en SQL" });
        res.json({ success: true, message: "Usuario actualizado" });
    });
});

// 10. REGISTRAR NUEVA MÁQUINA (Corregida con serial_number y mapeo inteligente)
app.post('/api/admin/machines', (req, res) => {
    const { name, client_id, operator_id, serial_number } = req.body;
    const final_client_id = client_id || operator_id;
    
    if (!name || !final_client_id || !serial_number) {
        return res.status(400).json({ error: "Falta nombre de máquina, número de serie o asignar un operador" });
    }

    const sql = "INSERT INTO machines (name, client_id, serial_number, total_hours, last_maintenance, total_fuel_consumed) VALUES (?, ?, ?, 0, 0, 0.00)";
    
    db.query(sql, [name, final_client_id, serial_number], (err, result) => {
        if (err) {
            console.error("❌ ERROR AL CREAR MÁQUINA:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: "Máquina registrada con éxito" });
    });
});

// 11. RESETEAR MANTENIMIENTO (Ciclo de 250h)
app.put('/api/admin/reset-maint/:id', (req, res) => {
    const machineId = req.params.id;
    const sql = "UPDATE machines SET last_maintenance = total_hours WHERE id = ?";
    
    db.query(sql, [machineId], (err, result) => {
        if (err) return res.status(500).json({ error: "No se pudo actualizar" });
        res.json({ success: true, message: "Contador reiniciado" });
    });
});

// 12. ELIMINAR USUARIO
app.delete('/api/admin/users/:id', (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM users WHERE id = ?";
    
    db.query(sql, [id], (err, result) => {
        if (err) {
            console.error("❌ ERROR SQL:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: "Usuario y sus registros eliminados" });
    });
});

// 13. ELIMINAR MÁQUINA
app.delete('/api/admin/machines/:id', (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM machines WHERE id = ?";
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 14. ACTUALIZAR / REASIGNAR MÁQUINA (Corregida con serial_number)
app.put('/api/admin/machines/:id', (req, res) => {
    const { id } = req.params;
    const { name, client_id, operator_id, total_hours, serial_number } = req.body;
    const final_client_id = client_id || operator_id;

    const sql = "UPDATE machines SET name = ?, client_id = ?, total_hours = ?, serial_number = ? WHERE id = ?";
    db.query(sql, [name, final_client_id, total_hours || 0, serial_number, id], (err, result) => {
        if (err) {
            console.error("❌ ERROR AL ACTUALIZAR MÁQUINA:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: "Unidad actualizada correctamente" });
    });
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => {
    console.log(`🚀 SERVIDOR INDUSTRIAL CORRIENDO EN PUERTO ${PORT}`);
});