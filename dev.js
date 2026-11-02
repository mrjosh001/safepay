// Local dev only: node --env-file=.env dev.js  (Vercel serves public/ and api/ itself)
import express from 'express';
import app from './api/index.js';
app.use(express.static('public'));
app.listen(process.env.PORT || 3000, () => console.log('Safepay dev server on http://localhost:' + (process.env.PORT || 3000)));
