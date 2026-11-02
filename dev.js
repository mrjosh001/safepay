import app from './api/index.js';
app.use(express_static());
function express_static() { return async (req, res, next) => next(); }
app.listen(process.env.PORT || 3000, () => console.log('Safepay dev server'));
