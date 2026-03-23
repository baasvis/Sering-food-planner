// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// Static files
app.use(express.static('public'));

// ── Mount routes ──

const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api', authRouter.requireAuth);

app.use('/api/data',              require('./routes/data'));
app.use('/api/batches',           require('./routes/batches'));
app.use('/api',                   require('./routes/recipes'));
app.use('/api/ingredients',       require('./routes/ingredients'));
app.use('/api',                   require('./routes/guests'));
app.use('/api',                   require('./routes/inventory'));
app.use('/api/feedback',          require('./routes/feedback'));
app.use('/api/health',            require('./routes/health'));

// ── Global error handler ──

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

module.exports = app;
