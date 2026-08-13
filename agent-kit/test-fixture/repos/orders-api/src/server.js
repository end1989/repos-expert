const express = require('express');
const app = express();
const PORT = process.env.PORT || 4000;

app.get('/health', (req, res) => res.json({ ok: true }));
app.post('/orders', (req, res) => res.status(201).json({ id: 'ord_1' }));
app.get('/orders/:id', (req, res) => res.json({ id: req.params.id }));

app.listen(PORT, () => console.log(`orders-api on ${PORT}`));
