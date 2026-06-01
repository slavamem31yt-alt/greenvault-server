const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            uid          TEXT PRIMARY KEY,
            email        TEXT NOT NULL,
            name         TEXT,
            hwid         TEXT NOT NULL,
            created_at   TIMESTAMP DEFAULT NOW(),
            last_login   TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS hwid_bindings (
            hwid       TEXT PRIMARY KEY,
            uid        TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS user_games (
            id         SERIAL PRIMARY KEY,
            uid        TEXT NOT NULL,
            game_id    TEXT NOT NULL,
            game_name  TEXT,
            added_at   TIMESTAMP DEFAULT NOW(),
            UNIQUE(uid, game_id)
        );

        CREATE TABLE IF NOT EXISTS activation_keys (
            key        TEXT PRIMARY KEY,
            game_id    TEXT NOT NULL,
            game_name  TEXT NOT NULL,
            used       BOOLEAN DEFAULT FALSE,
            used_by    TEXT,
            used_at    TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS games_catalog (
            game_id     TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            file_name   TEXT NOT NULL,
            available   BOOLEAN DEFAULT TRUE
        );
    `);

    await pool.query(`
        INSERT INTO activation_keys (key, game_id, game_name)
        VALUES ('ferv12-00032-1231g-213ricpik', 'g2tl-p', 'test acelert')
        ON CONFLICT (key) DO NOTHING;
    `);

    await pool.query(`
        INSERT INTO games_catalog (game_id, name, file_name) VALUES
            ('g1tl-p', 'comm_game',    'g1tl-p'),
            ('g2tl-p', 'test acelert', 'g2tl-p')
        ON CONFLICT (game_id) DO NOTHING;
    `);

    console.log('Database initialized');
}

app.post('/api/auth/register', async (req, res) => {
    try {
        const { uid, email, name, hwid } = req.body;
        if (!uid || !hwid) return res.json({ error: 'uid и hwid обязательны' });

        const existing = await pool.query(
            'SELECT uid FROM hwid_bindings WHERE hwid = $1', [hwid]);

        if (existing.rows.length > 0) {
            if (existing.rows[0].uid !== uid) {
                return res.json({
                    error: 'На этом устройстве уже зарегистрирован другой аккаунт'
                });
            }
        } else {
            await pool.query(
                'INSERT INTO hwid_bindings (hwid, uid) VALUES ($1, $2)',
                [hwid, uid]);
        }

        await pool.query(`
            INSERT INTO users (uid, email, name, hwid)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (uid) DO UPDATE
            SET email = $2, name = $3, last_login = NOW();
        `, [uid, email || '', name || '', hwid]);

        res.json({ success: true, uid });
    } catch (e) {
        console.error(e);
        res.json({ error: e.message });
    }
});

app.get('/api/games/check/:file', async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT available FROM games_catalog WHERE file_name = $1',
            [req.params.file]);
        if (r.rows.length === 0 || !r.rows[0].available) {
            return res.status(404).json({ exists: false });
        }
        res.json({ exists: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/keys/activate', async (req, res) => {
    try {
        const { uid, key } = req.body;
        if (!uid || !key) return res.json({ success: false, error: 'Нет данных' });

        const r = await pool.query(
            'SELECT * FROM activation_keys WHERE key = $1', [key]);

        if (r.rows.length === 0) {
            return res.json({ success: false, error: 'Неверный ключ' });
        }

        const k = r.rows[0];

        if (k.used && k.used_by !== uid) {
            return res.json({ success: false, error: 'Ключ уже использован' });
        }

        if (!k.used) {
            await pool.query(`
                UPDATE activation_keys
                SET used = TRUE, used_by = $1, used_at = NOW()
                WHERE key = $2
            `, [uid, key]);
        }

        await pool.query(`
            INSERT INTO user_games (uid, game_id, game_name)
            VALUES ($1, $2, $3)
            ON CONFLICT (uid, game_id) DO NOTHING;
        `, [uid, k.game_id, k.game_name]);

        res.json({ success: true, gameId: k.game_id, gameName: k.game_name });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/games/launch', async (req, res) => {
    try {
        const { uid, gameId, hwid } = req.body;

        const hb = await pool.query(
            'SELECT uid FROM hwid_bindings WHERE hwid = $1', [hwid]);
        if (hb.rows.length === 0 || hb.rows[0].uid !== uid) {
            return res.json({ success: false, error: 'Несовпадение HWID' });
        }

        const ug = await pool.query(
            'SELECT * FROM user_games WHERE uid = $1 AND game_id = $2',
            [uid, gameId]);
        if (ug.rows.length === 0) {
            return res.json({ success: false, error: 'Игра не куплена' });
        }

        const token = crypto.createHash('sha256')
            .update(uid + gameId + Date.now()).digest('hex');

        res.json({ success: true, token });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.use('/images', express.static(path.join(__dirname, 'images')));
app.use('/files', express.static(path.join(__dirname, 'files')));

app.get('/', (req, res) => {
    res.json({
        status: 'GreenVault Server',
        version: '1.0.0',
        time: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 10000;
initDB().then(() => {
    app.listen(PORT, () => console.log(`Server on port ${PORT}`));
}).catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
});
