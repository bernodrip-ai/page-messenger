const express = require('express');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const PORT = process.env.PORT || 3001;

// ============================================================
// GET PAGES FROM ENV
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
// IN-MEMORY STORAGE (No database needed!)
// ============================================================
let leads = [];
let users = [];
let groups = [];
let savedReplies = [];

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/signup', (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Email already exists' });
    }
    const user = { id: users.length + 1, name, email, password, created: new Date().toISOString() };
    users.push(user);
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
});

// ============================================================
// PAGES
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
// LEADS
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

        leads = allLeads;
        res.json({ leads, total: leads.length });
    } catch (error) {
        console.error('❌ Leads error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// GET LEADS (Fast)
// ============================================================
app.get('/api/leads/db/:pageId', (req, res) => {
    res.json({ leads });
});

// ============================================================
// SYNC STATUS
// ============================================================
app.get('/api/sync/status/:pageId', (req, res) => {
    res.json({ status: 'idle', totalLeads: leads.length, newLeads: 0 });
});

// ============================================================
// GROUPS
// ============================================================
app.get('/api/groups/:pageId', (req, res) => {
    res.json({ groups });
});

app.post('/api/groups', (req, res) => {
    const { pageId, groupName } = req.body;
    if (!pageId || !groupName) {
        return res.status(400).json({ error: 'pageId and groupName are required' });
    }
    const group = { id: groups.length + 1, pageId, name: groupName, created: new Date().toISOString(), leads: [] };
    groups.push(group);
    res.json({ success: true, group });
});

app.post('/api/groups/add-lead', (req, res) => {
    const { groupId, leadPsid } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.leads.includes(leadPsid)) {
        group.leads.push(leadPsid);
    }
    res.json({ success: true });
});

app.post('/api/groups/remove-lead', (req, res) => {
    const { groupId, leadPsid } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    group.leads = group.leads.filter(id => id !== leadPsid);
    res.json({ success: true });
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
    res.json({ replies: savedReplies });
});

app.post('/api/saved-replies', (req, res) => {
    const { keyword, message } = req.body;
    if (!keyword || !message) {
        return res.status(400).json({ error: 'keyword and message are required' });
    }
    const reply = { id: savedReplies.length + 1, keyword: keyword.toLowerCase(), message, created: new Date().toISOString() };
    savedReplies.push(reply);
    res.json({ success: true, reply });
});

// ============================================================
// SERVE FRONTEND FILES
// ============================================================
// ✅ Render par frontend folder root mein hai
const frontendPath = path.join(__dirname, '..', 'frontend');
console.log(`📁 Serving frontend from: ${frontendPath}`);

// ✅ Serve static files
app.use(express.static(frontendPath));

// ✅ Serve HTML files directly
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
app.get('/connect', (req, res) => {
    res.sendFile(path.join(frontendPath, 'connect.html'));
});

// ✅ Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'login.html'));
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📄 Pages loaded: ${PAGES.length}`);
    console.log(`📁 Serving frontend from: ${frontendPath}`);
});