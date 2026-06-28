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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ============================================================
// GET ALL PAGES WITH TOKENS FROM .env
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
// SQLite DATABASE (Using sql.js - Pure JavaScript)
// ============================================================
let db = null;
const fs = require('fs');
const dbPath = path.join(__dirname, 'database.db');

// Initialize database
async function initDatabase() {
    try {
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
            CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pageId TEXT,
                name TEXT,
                created TEXT,
                leads TEXT
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

            CREATE TABLE IF NOT EXISTS sync_status (
                pageId TEXT PRIMARY KEY,
                lastSync TEXT,
                status TEXT,
                totalLeads INTEGER DEFAULT 0,
                newLeads INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS saved_replies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER,
                keyword TEXT,
                message TEXT,
                created TEXT
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                email TEXT UNIQUE,
                password TEXT,
                created TEXT
            );
        `);
        
        // Save database
        saveDatabase();
        console.log('✅ SQLite database ready!');
        return true;
    } catch (err) {
        console.error('❌ Database initialization error:', err);
        return false;
    }
}

// Save database to file
function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
    }
}

// Helper to convert sql.js results to array of objects
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
    saveDatabase();
    return { changes: db.getRowsModified() };
}

function dbTransaction(callback) {
    db.exec('BEGIN TRANSACTION');
    try {
        callback();
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    saveDatabase();
}

// ============================================================
// AUTH: SIGNUP
// ============================================================
app.post('/api/auth/signup', (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    try {
        // Check if user exists
        const existing = dbGet(`SELECT * FROM users WHERE email = ?`, [email]);
        if (existing) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        
        dbRun(`INSERT INTO users (name, email, password, created) VALUES (?, ?, ?, ?)`, 
            [name, email, password, new Date().toISOString()]);
        const user = dbGet(`SELECT * FROM users WHERE email = ?`, [email]);
        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// AUTH: LOGIN
// ============================================================
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    try {
        const user = dbGet(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password]);
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GET ALL PAGES
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
// GET LEADS
// ============================================================
app.get('/api/leads/:pageId', async (req, res) => {
    const { pageId } = req.params;
    const page = PAGES.find(p => p.id === pageId);
    
    if (!page) {
        return res.status(404).json({ error: 'Page not found' });
    }

    try {
        console.log(`📡 Syncing ALL leads for page: ${pageId}`);
        
        let allLeads = [];
        const psids = new Set();
        let nextUrl = null;
        let pageCount = 0;
        const MAX_PAGES = 100;

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

        while (convRes.data.data && convRes.data.data.length > 0 && pageCount < MAX_PAGES) {
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

            pageCount++;
            console.log(`📄 Page ${pageCount} done, ${allLeads.length} leads found so far`);

            if (convRes.data.paging && convRes.data.paging.next) {
                nextUrl = convRes.data.paging.next;
                convRes = await axios.get(nextUrl);
                await new Promise(resolve => setTimeout(resolve, 300));
            } else {
                break;
            }
        }

        console.log(`✅ Total leads fetched: ${allLeads.length}`);

        // Insert leads using transaction
        dbTransaction(() => {
            // Clear existing leads for this page
            dbRun(`DELETE FROM leads WHERE pageId = ?`, [pageId]);
            
            // Insert all leads
            for (const lead of allLeads) {
                dbRun(
                    `INSERT INTO leads (pageId, psid, name, lastSync, lastMessage, lastMessageTime) VALUES (?, ?, ?, ?, ?, ?)`,
                    [pageId, lead.psid, lead.name, new Date().toISOString(), lead.lastMessage, lead.lastMessageTime]
                );
            }
        });

        dbRun(
            `INSERT OR REPLACE INTO sync_status (pageId, lastSync, status, totalLeads, newLeads) VALUES (?, ?, ?, ?, ?)`,
            [pageId, new Date().toISOString(), 'completed', allLeads.length, 0]
        );

        const dbLeads = dbAll(`SELECT * FROM leads WHERE pageId = ? ORDER BY lastMessageTime DESC`, [pageId]);

        res.json({ leads: dbLeads, total: dbLeads.length });

    } catch (error) {
        console.error('❌ Leads error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// ============================================================
// GET LEADS FROM DATABASE (Fast)
// ============================================================
app.get('/api/leads/db/:pageId', (req, res) => {
    const { pageId } = req.params;

    try {
        const rows = dbAll(`SELECT * FROM leads WHERE pageId = ? ORDER BY lastMessageTime DESC`, [pageId]);
        res.json({ leads: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GET SYNC STATUS
// ============================================================
app.get('/api/sync/status/:pageId', (req, res) => {
    const { pageId } = req.params;

    try {
        const row = dbGet(`SELECT * FROM sync_status WHERE pageId = ?`, [pageId]);
        res.json(row || { status: 'idle', totalLeads: 0, newLeads: 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// BACKGROUND SYNC
// ============================================================
let isSyncing = false;
let syncQueue = [];

app.post('/api/sync/start', async (req, res) => {
    const { pageId } = req.body;
    
    if (!pageId) {
        return res.status(400).json({ error: 'pageId is required' });
    }

    if (isSyncing) {
        syncQueue.push(pageId);
        return res.json({ 
            success: true, 
            message: 'Sync already in progress, added to queue',
            queued: true 
        });
    }

    isSyncing = true;
    
    dbRun(`INSERT OR REPLACE INTO sync_status (pageId, status, lastSync) VALUES (?, ?, ?)`, [pageId, 'in_progress', new Date().toISOString()]);

    res.json({ success: true, message: 'Sync started in background' });

    runBackgroundSync(pageId);
});

async function runBackgroundSync(pageId) {
    try {
        console.log(`🔁 Background sync started for page: ${pageId}`);
        
        const page = PAGES.find(p => p.id === pageId);
        if (!page) {
            console.error(`❌ Page not found: ${pageId}`);
            isSyncing = false;
            dbRun(`UPDATE sync_status SET status = 'failed' WHERE pageId = ?`, [pageId]);
            return;
        }

        const existingRows = dbAll(`SELECT psid FROM leads WHERE pageId = ?`, [pageId]);
        const existingPsids = new Set(existingRows.map(row => row.psid));

        let newLeads = [];
        let allLeads = [];
        const allPsids = new Set();
        let nextUrl = null;
        let pageCount = 0;
        const MAX_PAGES = 100;

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

        let newLeadCount = 0;

        while (convRes.data.data && convRes.data.data.length > 0 && pageCount < MAX_PAGES) {
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
                        for (const p of partsRes.data.participants.data) {
                            if (!allPsids.has(p.id)) {
                                allPsids.add(p.id);
                                const lead = {
                                    psid: p.id,
                                    name: p.name || 'Unknown User',
                                    lastMessage: 'Click to chat',
                                    lastMessageTime: new Date().toISOString()
                                };
                                allLeads.push(lead);

                                if (!existingPsids.has(p.id)) {
                                    newLeads.push(lead);
                                    newLeadCount++;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.log(`⚠️ Skipping conversation: ${conv.id}`);
                }
            }

            pageCount++;
            
            if (newLeads.length > 0) {
                dbRun(`UPDATE sync_status SET newLeads = ?, totalLeads = ? WHERE pageId = ?`, [newLeadCount, allLeads.length, pageId]);
            }

            console.log(`📄 Background: Page ${pageCount} done, ${allLeads.length} total, ${newLeadCount} new`);

            if (convRes.data.paging && convRes.data.paging.next) {
                nextUrl = convRes.data.paging.next;
                convRes = await axios.get(nextUrl);
                await new Promise(resolve => setTimeout(resolve, 300));
            } else {
                break;
            }
        }

        console.log(`✅ Background: Total leads: ${allLeads.length}, New: ${newLeadCount}`);

        if (allLeads.length > 0) {
            dbTransaction(() => {
                // Clear existing leads for this page
                dbRun(`DELETE FROM leads WHERE pageId = ?`, [pageId]);
                
                // Insert all leads
                for (const lead of allLeads) {
                    dbRun(
                        `INSERT INTO leads (pageId, psid, name, lastSync, lastMessage, lastMessageTime) VALUES (?, ?, ?, ?, ?, ?)`,
                        [pageId, lead.psid, lead.name, new Date().toISOString(), lead.lastMessage, lead.lastMessageTime]
                    );
                }
            });
        }

        dbRun(`UPDATE sync_status SET status = 'completed', lastSync = ?, totalLeads = ?, newLeads = ? WHERE pageId = ?`, [new Date().toISOString(), allLeads.length, newLeadCount, pageId]);

        console.log(`✅ Background sync completed for page: ${pageId}`);

    } catch (error) {
        console.error(`❌ Background sync error for ${pageId}:`, error.message);
        dbRun(`UPDATE sync_status SET status = 'failed' WHERE pageId = ?`, [pageId]);
    } finally {
        isSyncing = false;
        
        if (syncQueue.length > 0) {
            const nextPage = syncQueue.shift();
            runBackgroundSync(nextPage);
        }
    }
};

// ============================================================
// CHECK SYNC STATUS
// ============================================================
app.get('/api/sync/status', (req, res) => {
    res.json({
        isSyncing: isSyncing,
        queueLength: syncQueue.length
    });
});

// ============================================================
// GROUPS
// ============================================================
app.get('/api/groups/:pageId', (req, res) => {
    const { pageId } = req.params;

    try {
        const rows = dbAll(`SELECT * FROM groups WHERE pageId = ?`, [pageId]);
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
        dbRun(`INSERT INTO groups (pageId, name, created, leads) VALUES (?, ?, ?, ?)`, [pageId, groupName, new Date().toISOString(), '[]']);
        const group = dbGet(`SELECT * FROM groups WHERE pageId = ? ORDER BY id DESC LIMIT 1`, [pageId]);
        res.json({
            success: true,
            group: {
                id: group.id,
                name: group.name,
                created: group.created,
                leads: []
            }
        });
    } catch (err) {
        console.error('SQL Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/groups/:groupId', (req, res) => {
    const { groupId } = req.params;
    const { name } = req.body;
    
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }

    try {
        const result = dbRun(`UPDATE groups SET name = ? WHERE id = ?`, [name, groupId]);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }
        res.json({ success: true, message: 'Group updated successfully' });
    } catch (err) {
        console.error('SQL Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/groups/:groupId', (req, res) => {
    const { groupId } = req.params;

    try {
        const result = dbRun(`DELETE FROM groups WHERE id = ?`, [groupId]);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }
        res.json({ success: true, message: 'Group deleted successfully' });
    } catch (err) {
        console.error('SQL Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/groups/add-lead', (req, res) => {
    const { pageId, groupId, leadPsid } = req.body;
    if (!pageId || !groupId || !leadPsid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const row = dbGet(`SELECT * FROM groups WHERE id = ? AND pageId = ?`, [groupId, pageId]);
        if (!row) {
            return res.status(404).json({ error: 'Group not found' });
        }

        let leads = row.leads ? JSON.parse(row.leads) : [];
        if (!leads.includes(leadPsid)) {
            leads.push(leadPsid);
        }

        dbRun(`UPDATE groups SET leads = ? WHERE id = ?`, [JSON.stringify(leads), groupId]);
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
        const row = dbGet(`SELECT * FROM groups WHERE id = ? AND pageId = ?`, [groupId, pageId]);
        if (!row) {
            return res.status(404).json({ error: 'Group not found' });
        }

        let leads = row.leads ? JSON.parse(row.leads) : [];
        leads = leads.filter(id => id !== leadPsid);

        dbRun(`UPDATE groups SET leads = ? WHERE id = ?`, [JSON.stringify(leads), groupId]);
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
        
        dbRun(`UPDATE leads SET lastMessage = ?, lastMessageTime = ? WHERE pageId = ? AND psid = ?`, [message, new Date().toISOString(), pageId, recipientId]);

        console.log(`✅ Message sent with: ${tag || 'RESPONSE'}`);
        return res.json({ 
            success: true, 
            type: tag || 'standard', 
            data: response.data 
        });

    } catch (error) {
        console.error('❌ Send message error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// ============================================================
// BULK SEND
// ============================================================
app.post('/api/bulk-send', async (req, res) => {
    try {
        const { pageId, recipientIds, message, tag } = req.body;
        const page = PAGES.find(p => p.id === pageId);
        
        if (!page) {
            return res.status(404).json({ error: 'Page not found' });
        }

        if (!recipientIds || !Array.isArray(recipientIds) || recipientIds.length === 0) {
            return res.status(400).json({ error: 'recipientIds array and message are required' });
        }

        const results = [];
        for (const psid of recipientIds) {
            try {
                await new Promise(resolve => setTimeout(resolve, 500));
                
                let payload = {
                    recipient: { id: psid },
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

                const result = await axios.post(
                    `https://graph.facebook.com/v25.0/me/messages`,
                    payload,
                    {
                        params: { access_token: page.token }
                    }
                );
                results.push({ psid, status: 'sent', type: tag || 'standard' });
                
                dbRun(`UPDATE leads SET lastMessage = ?, lastMessageTime = ? WHERE pageId = ? AND psid = ?`, [message, new Date().toISOString(), pageId, psid]);
            } catch (error) {
                results.push({ psid, status: 'failed', error: error.response?.data || error.message });
            }
        }
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// SEND IMAGE
// ============================================================
app.post('/api/send-image', async (req, res) => {
    try {
        const { pageId, recipientId, imageUrl, caption } = req.body;
        const page = PAGES.find(p => p.id === pageId);
        
        if (!page) {
            return res.status(404).json({ error: 'Page not found' });
        }

        if (!recipientId || !imageUrl) {
            return res.status(400).json({ error: 'recipientId and imageUrl are required' });
        }

        const requestBody = {
            recipient: { id: recipientId },
            message: {
                attachment: {
                    type: 'image',
                    payload: {
                        url: imageUrl,
                        is_reusable: true
                    }
                }
            },
            messaging_type: 'RESPONSE'
        };

        if (caption) {
            requestBody.message.text = caption;
        }

        const response = await axios.post(
            `https://graph.facebook.com/v25.0/me/messages`,
            requestBody,
            {
                params: { access_token: page.token }
            }
        );
        
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error('❌ Send image error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// ============================================================
// SEND FILE
// ============================================================
app.post('/api/send-file', async (req, res) => {
    try {
        const { pageId, recipientId, fileUrl, filename } = req.body;
        const page = PAGES.find(p => p.id === pageId);
        
        if (!page) {
            return res.status(404).json({ error: 'Page not found' });
        }

        if (!recipientId || !fileUrl) {
            return res.status(400).json({ error: 'recipientId and fileUrl are required' });
        }

        const response = await axios.post(
            `https://graph.facebook.com/v25.0/me/messages`,
            {
                recipient: { id: recipientId },
                message: {
                    attachment: {
                        type: 'file',
                        payload: {
                            url: fileUrl,
                            is_reusable: true
                        }
                    }
                },
                messaging_type: 'RESPONSE'
            },
            {
                params: { access_token: page.token }
            }
        );
        
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error('❌ Send file error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// ============================================================
// SAVED REPLIES (CRUD)
// ============================================================
app.get('/api/saved-replies', (req, res) => {
    const userId = req.headers['user-id'] || 1;
    
    try {
        const rows = dbAll(`SELECT * FROM saved_replies WHERE userId = ? ORDER BY created DESC`, [userId]);
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
        dbRun(`INSERT INTO saved_replies (userId, keyword, message, created) VALUES (?, ?, ?, ?)`, [userId, keyword.toLowerCase(), message, new Date().toISOString()]);
        const reply = dbGet(`SELECT * FROM saved_replies WHERE userId = ? ORDER BY id DESC LIMIT 1`, [userId]);
        res.json({
            success: true,
            reply: {
                id: reply.id,
                keyword: reply.keyword,
                message: reply.message
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/saved-replies/:id', (req, res) => {
    const { id } = req.params;
    const { keyword, message } = req.body;
    const userId = req.headers['user-id'] || 1;
    
    if (!keyword && !message) {
        return res.status(400).json({ error: 'keyword or message is required' });
    }
    
    try {
        let query = 'UPDATE saved_replies SET ';
        const params = [];
        
        if (keyword) {
            query += 'keyword = ?, ';
            params.push(keyword.toLowerCase());
        }
        if (message) {
            query += 'message = ?, ';
            params.push(message);
        }
        query = query.slice(0, -2);
        query += ' WHERE id = ? AND userId = ?';
        params.push(id, userId);
        
        const result = dbRun(query, params);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Reply not found' });
        }
        res.json({ success: true, message: 'Reply updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/saved-replies/:id', (req, res) => {
    const { id } = req.params;
    const userId = req.headers['user-id'] || 1;
    
    try {
        const result = dbRun(`DELETE FROM saved_replies WHERE id = ? AND userId = ?`, [id, userId]);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Reply not found' });
        }
        res.json({ success: true, message: 'Reply deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// CHANGE PASSWORD
// ============================================================
app.post('/api/auth/change-password', (req, res) => {
    const { email, currentPassword, newPassword } = req.body;
    
    if (!email || !currentPassword || !newPassword) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    try {
        const user = dbGet(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, currentPassword]);
        if (!user) {
            return res.status(401).json({ error: 'Invalid current password' });
        }
        
        dbRun(`UPDATE users SET password = ? WHERE email = ?`, [newPassword, email]);
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// CHANGE EMAIL
// ============================================================
app.post('/api/auth/change-email', (req, res) => {
    const { email, newEmail, password } = req.body;
    
    if (!email || !newEmail || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    if (!newEmail.includes('@')) {
        return res.status(400).json({ error: 'Invalid email address' });
    }
    
    try {
        const user = dbGet(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password]);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        dbRun(`UPDATE users SET email = ? WHERE email = ?`, [newEmail, email]);
        res.json({ success: true, message: 'Email updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// DELETE ACCOUNT
// ============================================================
app.post('/api/auth/delete-account', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    
    try {
        const user = dbGet(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password]);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        dbRun(`DELETE FROM users WHERE email = ?`, [email]);
        res.json({ success: true, message: 'Account deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// WEBHOOK
// ============================================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verified!');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        body.entry.forEach(entry => {
            const webhookEvent = entry.messaging[0];
            if (webhookEvent && webhookEvent.message) {
                console.log(`💬 Message from ${webhookEvent.sender.id}`);
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// ============================================================
// SERVE FRONTEND FILES
// ============================================================
// ✅ Render par frontend folder root mein hai
const frontendPath = path.join(__dirname, '../frontend');
console.log('📁 Frontend path:', frontendPath);
app.use(express.static(frontendPath));

// ✅ Serve specific HTML files directly
app.get('/login', (req, res) => {
    res.sendFile(path.join(frontendPath, 'login.html'));
});
app.get('/signup', (req, res) => {
    res.sendFile(path.join(frontendPath, 'signup.html'));
});
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(frontendPath, 'dashboard.html'));
});
app.get('/leads', (req, res) => {
    res.sendFile(path.join(frontendPath, 'leads.html'));
});
app.get('/conversations', (req, res) => {
    res.sendFile(path.join(frontendPath, 'conversations.html'));
});
app.get('/groups', (req, res) => {
    res.sendFile(path.join(frontendPath, 'groups.html'));
});
app.get('/bulk', (req, res) => {
    res.sendFile(path.join(frontendPath, 'bulk.html'));
});

// ✅ Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'login.html'));
});

// ============================================================
// START SERVER
// ============================================================
initDatabase().then((success) => {
    if (success) {
        app.listen(PORT, () => {
            console.log(`🚀 Server is running on http://localhost:${PORT}`);
            console.log(`📄 Pages loaded: ${PAGES.length}`);
            console.log(`📁 Database: ${dbPath}`);
        });
    } else {
        console.error('❌ Failed to initialize database');
        process.exit(1);
    }
}).catch(err => {
    console.error('❌ Database initialization error:', err);
    process.exit(1);
});