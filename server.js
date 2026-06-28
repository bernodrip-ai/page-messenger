const express = require('express');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const initSqlJs = require('sql.js');

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const PORT = process.env.PORT || 3001;

console.log('🚀 Server starting...');

// ============================================================
// GET PAGES FROM .env
// ============================================================
function getPagesFromEnv() {
    const pages = [];
    let i = 1;
    while (process.env[`PAGE_${i}_ID`] && process.env[`PAGE_${i}_TOKEN`]) {
        pages.push({
            id: process.env[`PAGE_${i}_ID`],
            token: process.env[`PAGE_${i}_TOKEN`],
            name: `Page ${i}`
        });
        i++;
    }
    return pages;
}

const PAGES = getPagesFromEnv();
console.log(`📄 Loaded ${PAGES.length} pages from .env`);

// ============================================================
// DATABASE SETUP (sql.js - No compilation needed!)
// ============================================================
let db = null;
const fs = require('fs');
const dbPath = path.join(__dirname, 'database.db');

// Database functions
function dbAll(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let result = null;
    if (stmt.step()) {
        result = stmt.getAsObject();
    }
    stmt.free();
    return result;
}

function dbRun(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
    // Save database to file
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    return { changes: db.getRowsModified() };
}

// Initialize database
async function initDatabase() {
    const SQL = await initSqlJs();
    
    // Check if database file exists
    let fileBuffer = null;
    if (fs.existsSync(dbPath)) {
        fileBuffer = fs.readFileSync(dbPath);
    }
    
    // Create database
    db = new SQL.Database(fileBuffer);
    
    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            email TEXT UNIQUE,
            password TEXT,
            created TEXT
        );

        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pageId TEXT,
            psid TEXT,
            name TEXT,
            lastSync TEXT,
            lastMessage TEXT,
            lastMessageTime TEXT,
            UNIQUE(pageId, psid)
        );

        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pageId TEXT,
            name TEXT,
            created TEXT,
            leads TEXT
        );

        CREATE TABLE IF NOT EXISTS saved_replies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER,
            keyword TEXT,
            message TEXT,
            created TEXT
        );

        CREATE TABLE IF NOT EXISTS sync_status (
            pageId TEXT PRIMARY KEY,
            lastSync TEXT,
            status TEXT,
            totalLeads INTEGER DEFAULT 0,
            newLeads INTEGER DEFAULT 0
        );
    `);
    
    // Save database
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    
    console.log('✅ Database ready!');
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/signup', (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    try {
        const existing = dbGet('SELECT * FROM users WHERE email = ?', [email]);
        if (existing) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        
        dbRun('INSERT INTO users (name, email, password, created) VALUES (?, ?, ?, ?)', 
            [name, email, password, new Date().toISOString()]);
        const user = dbGet('SELECT * FROM users WHERE email = ?', [email]);
        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    try {
        const user = dbGet('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// PAGES ROUTE
// ============================================================
app.get('/api/pages', async (req, res) => {
    try {
        const pagesWithNames = [];
        for (const page of PAGES) {
            try {
                const response = await axios.get(
                    `https://graph.facebook.com/v25.0/${page.id}`,
                    {
                        params: {
                            access_token: page.token,
                            fields: 'id,name'
                        }
                    }
                );
                pagesWithNames.push({
                    id: response.data.id,
                    name: response.data.name,
                    token: page.token
                });
            } catch (error) {
                pagesWithNames.push({
                    id: page.id,
                    name: `Page ${page.id}`,
                    token: page.token
                });
            }
        }
        res.json({ data: pagesWithNames });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// LEADS ROUTES
// ============================================================
app.get('/api/leads/:pageId', async (req, res) => {
    const { pageId } = req.params;
    const page = PAGES.find(p => p.id === pageId);
    if (!page) {
        return res.status(404).json({ error: 'Page not found' });
    }

    try {
        console.log(`📡 Syncing leads for page: ${pageId}`);
        const allLeads = [];
        const psids = new Set();
        let convRes = await axios.get(
            `https://graph.facebook.com/v25.0/${pageId}/conversations`,
            {
                params: {
                    access_token: page.token,
                    platform: 'messenger',
                    limit: 100
                }
            }
        );

        if (convRes.data.data) {
            for (const conv of convRes.data.data) {
                try {
                    const partsRes = await axios.get(
                        `https://graph.facebook.com/v25.0/${conv.id}`,
                        {
                            params: {
                                access_token: page.token,
                                fields: 'participants'
                            }
                        }
                    );
                    if (partsRes.data.participants?.data) {
                        partsRes.data.participants.data.forEach(p => {
                            if (!psids.has(p.id)) {
                                psids.add(p.id);
                                allLeads.push({
                                    psid: p.id,
                                    name: p.name || 'Unknown User',
                                    lastMessage: 'Click to chat',
                                    lastMessageTime: new Date().toISOString()
                                });
                            }
                        });
                    }
                } catch (e) {
                    console.log(`⚠️ Skipping conversation: ${conv.id}`);
                }
            }
        }

        // Save to database
        dbRun('DELETE FROM leads WHERE pageId = ?', [pageId]);
        for (const lead of allLeads) {
            dbRun(
                'INSERT INTO leads (pageId, psid, name, lastSync, lastMessage, lastMessageTime) VALUES (?, ?, ?, ?, ?, ?)',
                [pageId, lead.psid, lead.name, new Date().toISOString(), lead.lastMessage, lead.lastMessageTime]
            );
        }

        dbRun('INSERT OR REPLACE INTO sync_status (pageId, lastSync, status, totalLeads, newLeads) VALUES (?, ?, ?, ?, ?)',
            [pageId, new Date().toISOString(), 'completed', allLeads.length, 0]);

        const dbLeads = dbAll('SELECT * FROM leads WHERE pageId = ? ORDER BY lastMessageTime DESC', [pageId]);
        res.json({ leads: dbLeads, total: dbLeads.length });
    } catch (error) {
        console.error('❌ Leads error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// GET LEADS FROM DATABASE (Fast)
// ============================================================
app.get('/api/leads/db/:pageId', (req, res) => {
    const { pageId } = req.params;
    try {
        const rows = dbAll('SELECT * FROM leads WHERE pageId = ? ORDER BY lastMessageTime DESC', [pageId]);
        res.json({ leads: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// SYNC STATUS
// ============================================================
app.get('/api/sync/status/:pageId', (req, res) => {
    const { pageId } = req.params;
    try {
        const row = dbGet('SELECT * FROM sync_status WHERE pageId = ?', [pageId]);
        res.json(row || { status: 'idle', totalLeads: 0, newLeads: 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GROUPS
// ============================================================
app.get('/api/groups/:pageId', (req, res) => {
    const { pageId } = req.params;
    try {
        const rows = dbAll('SELECT * FROM groups WHERE pageId = ?', [pageId]);
        const groups = rows.map(row => ({
            ...row,
            leads: row.leads ? JSON.parse(row.leads) : []
        }));
        res.json({ groups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/groups', (req, res) => {
    const { pageId, groupName } = req.body;
    if (!pageId || !groupName) {
        return res.status(400).json({ error: 'pageId and groupName are required' });
    }
    try {
        dbRun('INSERT INTO groups (pageId, name, created, leads) VALUES (?, ?, ?, ?)', 
            [pageId, groupName, new Date().toISOString(), '[]']);
        const group = dbGet('SELECT * FROM groups WHERE pageId = ? ORDER BY id DESC LIMIT 1', [pageId]);
        res.json({ success: true, group: { id: group.id, name: group.name, created: group.created, leads: [] } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/groups/add-lead', (req, res) => {
    const { pageId, groupId, leadPsid } = req.body;
    if (!pageId || !groupId || !leadPsid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        const row = dbGet('SELECT * FROM groups WHERE id = ? AND pageId = ?', [groupId, pageId]);
        if (!row) {
            return res.status(404).json({ error: 'Group not found' });
        }
        let leads = row.leads ? JSON.parse(row.leads) : [];
        if (!leads.includes(leadPsid)) {
            leads.push(leadPsid);
        }
        dbRun('UPDATE groups SET leads = ? WHERE id = ?', [JSON.stringify(leads), groupId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/groups/remove-lead', (req, res) => {
    const { pageId, groupId, leadPsid } = req.body;
    if (!pageId || !groupId || !leadPsid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        const row = dbGet('SELECT * FROM groups WHERE id = ? AND pageId = ?', [groupId, pageId]);
        if (!row) {
            return res.status(404).json({ error: 'Group not found' });
        }
        let leads = row.leads ? JSON.parse(row.leads) : [];
        leads = leads.filter(id => id !== leadPsid);
        dbRun('UPDATE groups SET leads = ? WHERE id = ?', [JSON.stringify(leads), groupId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// SEND MESSAGE
// ============================================================
app.post('/api/send-message', async (req, res) => {
    try {
        const { pageId, recipientId, message, tag } = req.body;
        const page = PAGES.find(p => p.id === pageId);
        if (!page) {
            return res.status(404).json({ error: 'Page not found' });
        }

        if (!recipientId || !message) {
            return res.status(400).json({ error: 'recipientId and message are required' });
        }

        console.log(`📤 Sending to ${recipientId}: Tag = ${tag || 'NO_TAG'}`);

        let payload = {
            recipient: { id: recipientId },
            message: { text: message }
        };

        if (tag === 'UTILITY') {
            payload.messaging_type = 'UTILITY';
        } else if (tag) {
            payload.messaging_type = 'MESSAGE_TAG';
            payload.message.tag = tag;
        } else {
            payload.messaging_type = 'RESPONSE';
        }

        const response = await axios.post(
            `https://graph.facebook.com/v25.0/me/messages`,
            payload,
            {
                params: { access_token: page.token }
            }
        );

        dbRun('UPDATE leads SET lastMessage = ?, lastMessageTime = ? WHERE pageId = ? AND psid = ?',
            [message, new Date().toISOString(), pageId, recipientId]);

        res.json({ success: true, type: tag || 'standard', data: response.data });
    } catch (error) {
        console.error('❌ Send message error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// ============================================================
// SAVED REPLIES
// ============================================================
app.get('/api/saved-replies', (req, res) => {
    const userId = req.headers['user-id'] || 1;
    try {
        const rows = dbAll('SELECT * FROM saved_replies WHERE userId = ? ORDER BY created DESC', [userId]);
        res.json({ replies: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/saved-replies', (req, res) => {
    const { keyword, message } = req.body;
    const userId = req.headers['user-id'] || 1;
    if (!keyword || !message) {
        return res.status(400).json({ error: 'keyword and message are required' });
    }
    try {
        dbRun('INSERT INTO saved_replies (userId, keyword, message, created) VALUES (?, ?, ?, ?)',
            [userId, keyword.toLowerCase(), message, new Date().toISOString()]);
        const reply = dbGet('SELECT * FROM saved_replies WHERE userId = ? ORDER BY id DESC LIMIT 1', [userId]);
        res.json({ success: true, reply: { id: reply.id, keyword: reply.keyword, message: reply.message } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// SERVE FRONTEND FILES
// ============================================================
const frontendPath = path.join(__dirname, '..', 'frontend');
console.log(`📁 Serving frontend from: ${frontendPath}`);
app.use(express.static(frontendPath));

app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'login.html'));
});

// ============================================================
// START SERVER
// ============================================================
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📄 Pages: ${PAGES.length}`);
        console.log(`📁 Frontend: ${frontendPath}`);
        console.log(`✅ Database: ${dbPath}`);
    });
}).catch(err => {
    console.error('❌ Database init error:', err);
    process.exit(1);
});