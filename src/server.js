import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { pool, query, connect } from './db.js';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const secret = process.env.JWT_SECRET;
const production = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const jwtIssuer = 'symplia-finanzas';
const jwtAudience = 'symplia-client';
const jwtVerificationOptions = { algorithms: ['HS256'], issuer: jwtIssuer, audience: jwtAudience };
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '24h';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL es obligatoria.');
if (!secret || (production && secret.length < 32)) throw new Error('JWT_SECRET debe tener al menos 32 caracteres en producción.');
if (production && !allowedOrigins.length) throw new Error('CORS_ORIGINS es obligatoria en producción.');

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || (!production && localOrigin.test(origin))) return callback(null, true);
    const error = new Error('Origen no permitido');
    error.status = 403;
    return callback(error);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  maxAge: 86400,
}));
app.use((_, res, next) => { res.setHeader('Cache-Control', 'no-store, private'); next(); });
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' },
}));
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_MAX || 10),
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.' },
});
app.use(express.json({ limit: '100kb' }));

const rows = async (sql, values) => (await query(sql, values)).rows;
const auth = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) throw new Error('Token ausente');
    req.user = jwt.verify(header.slice(7), secret, jwtVerificationOptions);
    res.setHeader('Cache-Control', 'no-store, private');
    next();
  } catch (_) { res.status(401).json({ error: 'Sesión no válida o vencida.' }); }
};
const createToken = (user) => jwt.sign(
  { id: user.id, email: user.email },
  secret,
  { algorithm: 'HS256', issuer: jwtIssuer, audience: jwtAudience, expiresIn: jwtExpiresIn },
);
const validEmail = (email) => typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
const validPassword = (password) => typeof password === 'string'
  && password.length >= 10 && password.length <= 128
  && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
const clientError = (message) => Object.assign(new Error(message), { expose: true });
const safeError = (error, fallback) => error?.expose ? error.message : fallback;
const dateText = (date) => date.toISOString().slice(0, 10);
const dateFrom = (text) => {
  // PostgreSQL puede entregar los campos DATE como Date; no les agregamos una
  // hora como si fueran texto porque eso vuelve inválida la fecha de una meta.
  if (text instanceof Date) {
    return new Date(
      text.getUTCFullYear(),
      text.getUTCMonth(),
      text.getUTCDate(),
      12,
    );
  }
  return new Date(`${text}T12:00:00`);
};
const validDate = (date) => !Number.isNaN(date.getTime());
const atDay = (year, month, day) => new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate()), 12);
const dueFor = (firstDate, frequency, index) => {
  const date = dateFrom(firstDate);
  if (frequency === 'biweekly') { date.setDate(date.getDate() + index * 15); return dateText(date); }
  return dateText(atDay(date.getFullYear(), date.getMonth() + index, date.getDate()));
};
const paymentPlan = (amount, installments, monthlyRate, frequency = 'monthly') => {
  const rate = (monthlyRate / 100) / (frequency === 'biweekly' ? 2 : 1);
  const payment = rate === 0 ? amount / installments : (amount * rate * Math.pow(1 + rate, installments)) / (Math.pow(1 + rate, installments) - 1);
  const installmentAmount = Math.round(payment * 100) / 100;
  return { installmentAmount, totalPayable: Math.round(installmentAmount * installments * 100) / 100 };
};
const cardFirstPaymentDate = (purchaseDate, closingDay, dueDay) => {
  const purchase = dateFrom(purchaseDate);
  const closing = atDay(purchase.getFullYear(), purchase.getMonth(), closingDay);
  const statementMonth = purchase <= closing ? purchase.getMonth() : purchase.getMonth() + 1;
  return dateText(atDay(purchase.getFullYear(), statementMonth + (dueDay <= closingDay ? 1 : 0), dueDay));
};
const insertSchedule = async (client, debtId, installments, firstPaymentDate, frequency, amount) => {
  for (let index = 0; index < installments; index += 1) await client.query(
    'INSERT INTO debt_installments(debt_id,installment_number,due_date,amount) VALUES($1,$2,$3,$4)',
    [debtId, index + 1, dueFor(firstPaymentDate, frequency, index), amount],
  );
};
const defaultCategories = [
  ['Salario', 'income', 'salary', '#1E3A5F'],
  ['Ingresos extra', 'income', 'salary', '#4F7CAC'],
  ['Freelance', 'income', 'salary', '#1E3A5F'],
  ['Rendimientos', 'income', 'salary', '#4F7CAC'],
  ['Reembolsos', 'income', 'category', '#1E3A5F'],
  ['Vivienda', 'expense', 'home', '#1E3A5F'],
  ['Alimentación', 'expense', 'food', '#EA580C'],
  ['Transporte', 'expense', 'car', '#4F7CAC'],
  ['Servicios públicos', 'expense', 'home', '#1E3A5F'],
  ['Salud', 'expense', 'health', '#DC2626'],
  ['Educación', 'expense', 'education', '#7C3AED'],
  ['Entretenimiento', 'expense', 'category', '#4F7CAC'],
  ['Compras personales', 'expense', 'shopping', '#EA580C'],
  ['Deudas y créditos', 'expense', 'category', '#1E3A5F'],
  ['Suscripciones', 'expense', 'category', '#4F7CAC'],
  ['Mascotas', 'expense', 'category', '#EA580C'],
  ['Impuestos', 'expense', 'category', '#DC2626'],
  ['Ahorro e inversión', 'expense', 'category', '#1E3A5F'],
  ['Otros gastos', 'expense', 'category', '#64748B'],
];
const seedDefaultCategories = async (client, userId) => {
  for (const [name, type, icon, color] of defaultCategories) await client.query(
    'INSERT INTO categories(user_id,name,type,icon,color) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,name,type) DO NOTHING',
    [userId, name, type, icon, color],
  );
};
const ensureOwnedReference = async (client, table, id, userId, label, expectedType = null) => {
  if (!id) return;
  const columns = table === 'categories' ? 'id,type' : 'id';
  const { rows: [reference] } = await client.query(
    `SELECT ${columns} FROM ${table} WHERE id=$1 AND user_id=$2`,
    [id, userId],
  );
  if (!reference || (expectedType && reference.type !== expectedType)) throw clientError(`${label} inválida`);
};
const reportMonth = async (userId, month) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw clientError('Mes inválido. Usa AAAA-MM.');
  const [year, monthNumber] = month.split('-').map(Number);
  const start = `${month}-01`; const end = dateText(new Date(year, monthNumber, 1, 12));
  const [[income], [expense], categories, cards, debts, investments, accounts, recent] = await Promise.all([
    rows("SELECT COALESCE(SUM(amount),0) amount FROM transactions WHERE user_id=$1 AND type='income' AND transaction_date >= $2::date AND transaction_date < $3::date", [userId, start, end]),
    rows("SELECT COALESCE(SUM(amount),0) amount FROM transactions WHERE user_id=$1 AND type='expense' AND transaction_date >= $2::date AND transaction_date < $3::date", [userId, start, end]),
    rows(`SELECT COALESCE(c.name,'Sin categoría') name,t.type,COALESCE(SUM(t.amount),0) amount FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=$1 AND t.type IN ('income','expense') AND t.transaction_date >= $2::date AND t.transaction_date < $3::date GROUP BY c.name,t.type ORDER BY amount DESC`, [userId, start, end]),
    rows('SELECT name,issuer,credit_limit,current_debt,GREATEST(credit_limit-current_debt,0) available_credit FROM credit_cards WHERE user_id=$1 AND is_active ORDER BY current_debt DESC', [userId]),
    rows("SELECT d.name,d.outstanding_amount,d.total_installments,d.credit_card_id,cc.name credit_card_name FROM debts d LEFT JOIN credit_cards cc ON cc.id=d.credit_card_id WHERE d.user_id=$1 AND d.status='active' ORDER BY d.outstanding_amount DESC", [userId]),
    rows("SELECT name,type,target_amount,current_amount,status FROM investments WHERE user_id=$1 AND status='active' ORDER BY current_amount DESC", [userId]),
    rows('SELECT name,current_balance,type FROM accounts WHERE user_id=$1 AND is_active ORDER BY current_balance DESC', [userId]),
    rows(`SELECT t.transaction_date,t.type,t.amount,t.note,COALESCE(c.name,'Sin categoría') category FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=$1 AND t.transaction_date >= $2::date AND t.transaction_date < $3::date ORDER BY t.transaction_date DESC,t.created_at DESC`, [userId, start, end]),
  ]);
  const totalBalance = accounts.reduce((sum, account) => sum + Number(account.current_balance), 0);
  const totalCards = cards.reduce((sum, card) => sum + Number(card.current_debt), 0);
  const totalDebt = debts.reduce((sum, debt) => sum + Number(debt.outstanding_amount), 0);
  const totalInvestments = investments.reduce((sum, investment) => sum + Number(investment.current_amount), 0);
  return { month, income: Number(income.amount), expense: Number(expense.amount), balance: Number(income.amount) - Number(expense.amount), total_balance: totalBalance, total_cards: totalCards, total_debt: totalDebt, total_investments: totalInvestments, categories, cards, debts, investments, accounts, transactions: recent };
};

app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.post('/auth/register', authLimiter, async (req, res) => {
  const { name, email, password, national_id, phone, address, city, birth_date } = req.body;
  if (!name?.trim() || !validEmail(email) || !validPassword(password) || !national_id?.trim() || !phone?.trim() || !address?.trim() || !city?.trim() || !birth_date || !validDate(dateFrom(birth_date))) return res.status(400).json({ error: 'Completa tus datos. La contraseña debe tener mínimo 10 caracteres, mayúscula, minúscula y número.' });
  const client = await connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query('INSERT INTO users(name,email,password_hash,national_id,phone,address,city,birth_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,email,currency,onboarding_completed', [name.trim(), email.toLowerCase(), await bcrypt.hash(password, 12), national_id.trim(), phone.trim(), address.trim(), city.trim(), birth_date]);
    await seedDefaultCategories(client, user.id);
    const token = createToken(user);
    await client.query('COMMIT');
    res.status(201).json({ user, token });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.code === '23505' ? 409 : 400).json({ error: error.code === '23505' ? 'El correo ya está registrado' : 'No se pudo crear la cuenta' });
  } finally { client.release(); }
});
app.post('/auth/login', authLimiter, async (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  if (!validEmail(email) || typeof req.body.password !== 'string') return res.status(401).json({ error: 'Credenciales inválidas' });
  const [user] = await rows('SELECT * FROM users WHERE email=$1', [email]);
  if (!user || !await bcrypt.compare(req.body.password || '', user.password_hash)) return res.status(401).json({ error: 'Credenciales inválidas' });
  if (bcrypt.getRounds(user.password_hash) < 12) await rows('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [await bcrypt.hash(req.body.password, 12), user.id]);
  res.json({ user: { id: user.id, name: user.name, email: user.email, currency: user.currency, onboarding_completed: user.onboarding_completed }, token: createToken(user) });
});
app.get('/profile', auth, async (req, res) => {
  const [user] = await rows('SELECT id,name,email,currency,national_id,phone,address,city,birth_date,onboarding_completed,created_at FROM users WHERE id=$1', [req.user.id]);
  const accounts = await rows('SELECT * FROM accounts WHERE user_id=$1 ORDER BY is_active DESC,created_at DESC', [req.user.id]);
  res.json({ user, accounts });
});
app.patch('/profile', auth, async (req, res) => {
  const allowed = ['name', 'national_id', 'phone', 'address', 'city', 'birth_date']; const entries = allowed.filter((key) => Object.hasOwn(req.body, key));
  if (!entries.length) return res.status(400).json({ error: 'No hay cambios para guardar' });
  const [user] = await rows(`UPDATE users SET ${entries.map((key, index) => `${key}=$${index + 1}`).join(',')},updated_at=now() WHERE id=$${entries.length + 1} RETURNING id,name,email,currency,national_id,phone,address,city,birth_date`, [...entries.map((key) => req.body[key] || null), req.user.id]);
  res.json(user);
});
app.post('/onboarding/complete', auth, async (req, res) => {
  const [user] = await rows('UPDATE users SET onboarding_completed=true,updated_at=now() WHERE id=$1 RETURNING id,name,onboarding_completed', [req.user.id]);
  res.json(user);
});
app.get('/dashboard', auth, async (req, res) => {
  const id = req.user.id;
  const [[income], [previousIncome], [expense], [debt], [cards], [investments], [balance], scheduled, recent] = await Promise.all([
    rows("SELECT COALESCE(SUM(amount),0) amount FROM transactions WHERE user_id=$1 AND type='income' AND date_trunc('month',transaction_date)=date_trunc('month',current_date)", [id]),
    rows("SELECT COALESCE(SUM(amount),0) amount FROM transactions WHERE user_id=$1 AND type='income' AND date_trunc('month',transaction_date)=date_trunc('month',current_date - interval '1 month')", [id]),
    rows("SELECT COALESCE(SUM(amount),0) amount FROM transactions WHERE user_id=$1 AND type='expense' AND date_trunc('month',transaction_date)=date_trunc('month',current_date)", [id]),
    rows("SELECT COALESCE(SUM(outstanding_amount),0) amount FROM debts WHERE user_id=$1 AND status='active'", [id]),
    rows('SELECT COALESCE(SUM(current_debt),0) amount, COALESCE(SUM(credit_limit-current_debt),0) available, COALESCE(SUM(credit_limit),0) credit_limit FROM credit_cards WHERE user_id=$1 AND is_active', [id]),
    rows("SELECT COALESCE(SUM(current_amount),0) amount FROM investments WHERE user_id=$1 AND status='active'", [id]),
    rows('SELECT COALESCE(SUM(current_balance),0) amount FROM accounts WHERE user_id=$1 AND is_active', [id]),
    rows('SELECT * FROM scheduled_payments WHERE user_id=$1 AND is_active ORDER BY next_due_date', [id]),
    rows(`SELECT t.*,c.name category,a.name account,cc.name card FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN credit_cards cc ON cc.id=t.card_id WHERE t.user_id=$1 ORDER BY transaction_date DESC,created_at DESC LIMIT 8`, [id]),
  ]);
  res.json({ income, previous_income: previousIncome, expense, debt, cards, investments, balance, scheduled, recent });
});

const resource = (table, columns) => {
  app.get(`/${table}`, auth, async (req, res) => res.json(await rows(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY created_at DESC`, [req.user.id])));
  app.post(`/${table}`, auth, async (req, res) => {
    const [result] = await rows(`INSERT INTO ${table}(user_id,${columns.join(',')}) VALUES($1,${columns.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING *`, [req.user.id, ...columns.map((key) => req.body[key])]);
    res.status(201).json(result);
  });
};
resource('accounts', ['name', 'type', 'institution', 'current_balance', 'color', 'account_number', 'holder_name', 'branch', 'contact_phone', 'address', 'notes']);
app.get('/scheduled_payments', auth, async (req, res) => res.json(await rows('SELECT * FROM scheduled_payments WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id])));
app.post('/scheduled_payments', auth, async (req, res) => {
  const { account_id, category_id, name, amount, payment_day, next_due_date, frequency = 'monthly', notes } = req.body;
  const value = Number(amount); const day = Number(payment_day);
  if (!name?.trim() || !Number.isFinite(value) || value <= 0 || ![15, 30].includes(day) || !validDate(dateFrom(next_due_date)) || !['monthly', 'once'].includes(frequency)) return res.status(400).json({ error: 'Datos del pago programado inválidos' });
  const client = await connect();
  try {
    await client.query('BEGIN');
    await ensureOwnedReference(client, 'accounts', account_id, req.user.id, 'Cuenta');
    await ensureOwnedReference(client, 'categories', category_id, req.user.id, 'Categoría', 'expense');
    const { rows: [payment] } = await client.query('INSERT INTO scheduled_payments(user_id,account_id,category_id,name,amount,payment_day,next_due_date,frequency,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [req.user.id, account_id || null, category_id || null, name.trim(), value, day, next_due_date, frequency, notes?.trim() || null]);
    await client.query('COMMIT');
    res.status(201).json(payment);
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo crear el pago programado.') }); } finally { client.release(); }
});

app.get('/categories', auth, async (req, res) => res.json(await rows('SELECT * FROM categories WHERE user_id=$1 ORDER BY type,name', [req.user.id])));
app.post('/categories', auth, async (req, res) => {
  const { name, type, icon = 'category', color = '#1E3A5F' } = req.body;
  if (!name?.trim() || !['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Categoría inválida' });
  try { const [category] = await rows('INSERT INTO categories(user_id,name,type,icon,color) VALUES($1,$2,$3,$4,$5) RETURNING *', [req.user.id, name.trim(), type, icon, color]); res.status(201).json(category); } catch (_) { res.status(409).json({ error: 'Ya existe una categoría con ese nombre y tipo' }); }
});
app.patch('/categories/:id', auth, async (req, res) => {
  const allowed = ['name', 'type', 'icon', 'color', 'is_active']; const entries = allowed.filter((key) => Object.hasOwn(req.body, key));
  if (!entries.length) return res.status(400).json({ error: 'No hay cambios para guardar' });
  const [category] = await rows(`UPDATE categories SET ${entries.map((key, index) => `${key}=$${index + 1}`).join(',')} WHERE id=$${entries.length + 1} AND user_id=$${entries.length + 2} RETURNING *`, [...entries.map((key) => req.body[key]), req.params.id, req.user.id]);
  if (!category) return res.status(404).json({ error: 'Categoría no encontrada' }); res.json(category);
});
app.delete('/categories/:id', auth, async (req, res) => {
  const client = await connect();
  try {
    await client.query('BEGIN');
    const { rows: [category] } = await client.query('SELECT id FROM categories WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!category) throw clientError('Categoría no encontrada');
    await client.query('UPDATE transactions SET category_id=NULL WHERE user_id=$1 AND category_id=$2', [req.user.id, category.id]);
    await client.query('UPDATE scheduled_payments SET category_id=NULL WHERE user_id=$1 AND category_id=$2', [req.user.id, category.id]);
    await client.query('UPDATE card_purchases SET category_id=NULL WHERE user_id=$1 AND category_id=$2', [req.user.id, category.id]);
    await client.query('DELETE FROM categories WHERE id=$1 AND user_id=$2', [category.id, req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, preserved_history: true });
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo eliminar la categoría.') }); } finally { client.release(); }
});

app.get('/transactions', auth, async (req, res) => res.json(await rows(`SELECT t.*,a.name account,cc.name card,c.name category FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN credit_cards cc ON cc.id=t.card_id LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=$1 ORDER BY t.transaction_date DESC,t.created_at DESC`, [req.user.id])));
app.post('/transactions', auth, async (req, res) => {
  const { account_id, category_id, type, amount, transaction_date, note } = req.body;
  const value = Number(amount);
  if (!account_id || !['income', 'expense'].includes(type) || !Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Movimiento inválido' });
  const client = await connect();
  try {
    await client.query('BEGIN');
    const [account] = (await client.query('SELECT id FROM accounts WHERE id=$1 AND user_id=$2 AND is_active', [account_id, req.user.id])).rows;
    if (!account) throw clientError('Cuenta inválida');
    await ensureOwnedReference(client, 'categories', category_id, req.user.id, 'Categoría', type);
    const [transaction] = (await client.query('INSERT INTO transactions(user_id,account_id,category_id,type,amount,transaction_date,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.user.id, account_id, category_id || null, type, value, transaction_date || dateText(new Date()), note || null])).rows;
    await client.query('UPDATE accounts SET current_balance=current_balance+$1 WHERE id=$2', [type === 'income' ? value : -value, account_id]);
    await client.query('COMMIT'); res.status(201).json(transaction);
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo registrar el movimiento.') }); } finally { client.release(); }
});

app.get('/credit_cards', auth, async (req, res) => res.json(await rows(`SELECT cc.*,GREATEST(cc.credit_limit-cc.current_debt,0) available_credit,COUNT(d.id) FILTER (WHERE d.status='active')::int active_purchases FROM credit_cards cc LEFT JOIN debts d ON d.credit_card_id=cc.id WHERE cc.user_id=$1 GROUP BY cc.id ORDER BY cc.created_at DESC`, [req.user.id])));
app.post('/credit_cards', auth, async (req, res) => {
  const { name, issuer, credit_limit, closing_day, due_day, color = '#1D4ED8', interest_rate_monthly = 0 } = req.body;
  const limit = Number(credit_limit); const rate = Number(interest_rate_monthly); const close = Number(closing_day); const due = Number(due_day);
  if (!name || !Number.isFinite(limit) || limit < 0 || !Number.isFinite(rate) || rate < 0 || !Number.isInteger(close) || !Number.isInteger(due) || close < 1 || close > 31 || due < 1 || due > 31) return res.status(400).json({ error: 'Datos de tarjeta inválidos' });
  const [card] = await rows('INSERT INTO credit_cards(user_id,name,issuer,credit_limit,current_debt,closing_day,due_day,color,interest_rate_monthly) VALUES($1,$2,$3,$4,0,$5,$6,$7,$8) RETURNING *', [req.user.id, name.trim(), issuer?.trim() || null, limit, close, due, color, rate]);
  res.status(201).json(card);
});
app.patch('/credit_cards/:id', auth, async (req, res) => {
  const allowed = ['name', 'issuer', 'credit_limit', 'closing_day', 'due_day', 'color', 'interest_rate_monthly', 'is_active']; const entries = allowed.filter((key) => Object.hasOwn(req.body, key));
  if (!entries.length) return res.status(400).json({ error: 'No hay cambios para guardar' });
  const [card] = await rows(`UPDATE credit_cards SET ${entries.map((key, index) => `${key}=$${index + 1}`).join(',')} WHERE id=$${entries.length + 1} AND user_id=$${entries.length + 2} RETURNING *`, [...entries.map((key) => req.body[key]), req.params.id, req.user.id]);
  if (!card) return res.status(404).json({ error: 'Tarjeta no encontrada' }); res.json(card);
});
app.delete('/credit_cards/:id', auth, async (req, res) => {
  const client = await connect();
  try {
    await client.query('BEGIN');
    const { rows: [card] } = await client.query('SELECT id FROM credit_cards WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
    if (!card) throw clientError('Tarjeta no encontrada');
    await client.query('UPDATE debts SET credit_card_id=NULL WHERE user_id=$1 AND credit_card_id=$2', [req.user.id, card.id]);
    await client.query('DELETE FROM credit_cards WHERE id=$1 AND user_id=$2', [card.id, req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, preserved_history: true });
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo eliminar la tarjeta.') }); } finally { client.release(); }
});
app.get('/card-purchases', auth, async (req, res) => res.json(await rows(`SELECT cp.*,cc.name card_name,d.outstanding_amount,d.status debt_status,d.total_payable FROM card_purchases cp JOIN credit_cards cc ON cc.id=cp.card_id JOIN debts d ON d.id=cp.debt_id WHERE cp.user_id=$1 ORDER BY cp.purchase_date DESC,cp.created_at DESC`, [req.user.id])));
app.post('/card-purchases', auth, async (req, res) => {
  const { card_id, category_id, amount, installments, purchase_date, description } = req.body;
  const value = Number(amount); const count = Number(installments); const purchaseDate = purchase_date || dateText(new Date());
  if (!card_id || !description?.trim() || !Number.isFinite(value) || value <= 0 || !Number.isInteger(count) || count < 1 || !validDate(dateFrom(purchaseDate))) return res.status(400).json({ error: 'Datos de compra inválidos' });
  const client = await connect();
  try {
    await client.query('BEGIN');
    const [card] = (await client.query('SELECT * FROM credit_cards WHERE id=$1 AND user_id=$2 AND is_active FOR UPDATE', [card_id, req.user.id])).rows;
    if (!card) throw clientError('Tarjeta inválida');
    await ensureOwnedReference(client, 'categories', category_id, req.user.id, 'Categoría', 'expense');
    const firstPaymentDate = cardFirstPaymentDate(purchaseDate, card.closing_day, card.due_day);
    const plan = paymentPlan(value, count, Number(card.interest_rate_monthly));
    if (Number(card.current_debt) + plan.totalPayable > Number(card.credit_limit)) throw clientError('La compra supera el cupo disponible de la tarjeta');
    const [debt] = (await client.query(`INSERT INTO debts(user_id,name,original_amount,outstanding_amount,total_payable,interest_rate_monthly,total_installments,payment_day,start_date,frequency,first_payment_date,credit_card_id) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,'monthly',$9,$10) RETURNING *`, [req.user.id, `Compra ${card.name}: ${description.trim()}`, value, plan.totalPayable, Number(card.interest_rate_monthly), count, dateFrom(firstPaymentDate).getDate(), purchaseDate, firstPaymentDate, card.id])).rows;
    await insertSchedule(client, debt.id, count, firstPaymentDate, 'monthly', plan.installmentAmount);
    const [purchase] = (await client.query('INSERT INTO card_purchases(user_id,card_id,debt_id,category_id,amount,installments,purchase_date,first_payment_date,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [req.user.id, card.id, debt.id, category_id || null, value, count, purchaseDate, firstPaymentDate, description.trim()])).rows;
    await client.query("INSERT INTO transactions(user_id,card_id,category_id,type,amount,transaction_date,note) VALUES($1,$2,$3,'expense',$4,$5,$6)", [req.user.id, card.id, category_id || null, value, purchaseDate, `Compra con ${card.name}: ${description.trim()}`]);
    await client.query('UPDATE credit_cards SET current_debt=current_debt+$1 WHERE id=$2', [plan.totalPayable, card.id]);
    await client.query('COMMIT'); res.status(201).json({ purchase, debt, installment_amount: plan.installmentAmount, first_payment_date: firstPaymentDate });
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo registrar la compra con tarjeta.') }); } finally { client.release(); }
});

app.get('/debts', auth, async (req, res) => res.json(await rows(`SELECT d.*,cc.name credit_card_name,COUNT(i.id)::int total_scheduled,COUNT(i.id) FILTER (WHERE i.status='paid')::int paid_installments,MIN(i.due_date) FILTER (WHERE i.status IN ('pending','overdue')) next_payment_date,COALESCE(SUM(i.amount) FILTER (WHERE i.status IN ('pending','overdue')),0) scheduled_balance FROM debts d LEFT JOIN debt_installments i ON i.debt_id=d.id LEFT JOIN credit_cards cc ON cc.id=d.credit_card_id WHERE d.user_id=$1 GROUP BY d.id,cc.name ORDER BY d.created_at DESC`, [req.user.id])));
app.post('/debts', auth, async (req, res) => {
  const { name, amount, total_installments, frequency, first_payment_date, interest_rate_monthly = 0 } = req.body; const value = Number(amount); const count = Number(total_installments); const rate = Number(interest_rate_monthly);
  if (!name || !Number.isFinite(value) || value <= 0 || !Number.isInteger(count) || count < 1 || !Number.isFinite(rate) || rate < 0 || !['monthly', 'biweekly'].includes(frequency) || !first_payment_date || !validDate(dateFrom(first_payment_date))) return res.status(400).json({ error: 'Datos de deuda inválidos' });
  const client = await connect();
  try {
    await client.query('BEGIN'); const plan = paymentPlan(value, count, rate, frequency);
    const [debt] = (await client.query(`INSERT INTO debts(user_id,name,original_amount,outstanding_amount,total_payable,interest_rate_monthly,total_installments,payment_day,start_date,frequency,first_payment_date) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$8) RETURNING *`, [req.user.id, name.trim(), value, plan.totalPayable, rate, count, dateFrom(first_payment_date).getDate(), first_payment_date, frequency])).rows;
    await insertSchedule(client, debt.id, count, first_payment_date, frequency, plan.installmentAmount);
    await client.query('COMMIT'); res.status(201).json(debt);
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo crear la deuda.') }); } finally { client.release(); }
});
app.patch('/debts/:id', auth, async (req, res) => {
  const { name, amount, total_installments, frequency, first_payment_date, interest_rate_monthly } = req.body;
  const client = await connect();
  try {
    await client.query('BEGIN');
    const { rows: [debt] } = await client.query('SELECT d.*,COUNT(i.id) FILTER (WHERE i.status=\'paid\')::int paid_count FROM debts d LEFT JOIN debt_installments i ON i.debt_id=d.id WHERE d.id=$1 AND d.user_id=$2 GROUP BY d.id FOR UPDATE', [req.params.id, req.user.id]);
    if (!debt) throw clientError('Deuda no encontrada');
    const changingPlan = ['amount', 'total_installments', 'frequency', 'first_payment_date', 'interest_rate_monthly'].some((key) => Object.hasOwn(req.body, key));
    if (changingPlan && (Number(debt.paid_count) > 0 || debt.credit_card_id)) throw clientError('Solo puedes cambiar el nombre después de registrar pagos o en compras de tarjeta. Así protegemos el historial y las cuotas ya calculadas.');
    if (!changingPlan) {
      if (!name?.trim()) throw clientError('Escribe un nombre para la deuda');
      const { rows: [updated] } = await client.query('UPDATE debts SET name=$1 WHERE id=$2 AND user_id=$3 RETURNING *', [name.trim(), debt.id, req.user.id]);
      await client.query('COMMIT'); return res.json(updated);
    }
    const value = Number(amount); const count = Number(total_installments); const rate = Number(interest_rate_monthly ?? 0);
    if (!name?.trim() || !Number.isFinite(value) || value <= 0 || !Number.isInteger(count) || count < 1 || !Number.isFinite(rate) || rate < 0 || !['monthly', 'biweekly'].includes(frequency) || !validDate(dateFrom(first_payment_date))) throw clientError('Datos de deuda inválidos');
    const plan = paymentPlan(value, count, rate, frequency);
    await client.query('DELETE FROM debt_installments WHERE debt_id=$1', [debt.id]);
    const { rows: [updated] } = await client.query('UPDATE debts SET name=$1,original_amount=$2,outstanding_amount=$3,total_payable=$3,interest_rate_monthly=$4,total_installments=$5,payment_day=$6,start_date=$7,frequency=$8,first_payment_date=$7 WHERE id=$9 RETURNING *', [name.trim(), value, plan.totalPayable, rate, count, dateFrom(first_payment_date).getDate(), first_payment_date, frequency, debt.id]);
    await insertSchedule(client, debt.id, count, first_payment_date, frequency, plan.installmentAmount);
    await client.query('COMMIT');
    res.json(updated);
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo actualizar la deuda.') }); } finally { client.release(); }
});
app.delete('/debts/:id', auth, async (req, res) => {
  const client = await connect();
  try {
    await client.query('BEGIN');
    const { rows: [debt] } = await client.query('SELECT * FROM debts WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
    if (!debt) throw clientError('Deuda no encontrada');
    if (debt.credit_card_id) await client.query('UPDATE credit_cards SET current_debt=GREATEST(0,current_debt-$1) WHERE id=$2 AND user_id=$3', [debt.outstanding_amount, debt.credit_card_id, req.user.id]);
    await client.query('DELETE FROM debts WHERE id=$1 AND user_id=$2', [debt.id, req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, preserved_history: true });
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo eliminar la deuda.') }); } finally { client.release(); }
});
app.get('/debts/:id/installments', auth, async (req, res) => res.json(await rows('SELECT i.* FROM debt_installments i JOIN debts d ON d.id=i.debt_id WHERE i.debt_id=$1 AND d.user_id=$2 ORDER BY i.installment_number', [req.params.id, req.user.id])));
app.patch('/debt-installments/:id/pay', auth, async (req, res) => {
  const client = await connect();
  try {
    await client.query('BEGIN');
    const [installment] = (await client.query(`SELECT i.*,d.user_id,d.id debt_uuid,d.name debt_name,d.credit_card_id FROM debt_installments i JOIN debts d ON d.id=i.debt_id WHERE i.id=$1 FOR UPDATE`, [req.params.id])).rows;
    if (!installment || installment.user_id !== req.user.id) throw clientError('Cuota no encontrada'); if (installment.status === 'paid') throw clientError('Esta cuota ya fue pagada');
    const accountId = req.body?.account_id; if (!accountId) throw clientError('Selecciona la cuenta desde la que realizaste el pago');
    const [account] = (await client.query('SELECT id FROM accounts WHERE id=$1 AND user_id=$2 AND is_active=true', [accountId, req.user.id])).rows; if (!account) throw clientError('Cuenta de pago inválida');
    await client.query('INSERT INTO transactions(user_id,account_id,card_id,type,amount,transaction_date,note) VALUES($1,$2,$3,$4,$5,current_date,$6)', [req.user.id, accountId, installment.credit_card_id || null, installment.credit_card_id ? 'transfer' : 'expense', installment.amount, installment.credit_card_id ? `Pago de tarjeta: ${installment.debt_name}` : `Cuota de deuda: ${installment.debt_name}`]);
    await client.query('UPDATE accounts SET current_balance=current_balance-$1 WHERE id=$2', [installment.amount, accountId]);
    await client.query("UPDATE debt_installments SET status='paid',paid_at=current_date WHERE id=$1", [installment.id]);
    const [debt] = (await client.query('UPDATE debts SET outstanding_amount=GREATEST(0,outstanding_amount-$1) WHERE id=$2 RETURNING *', [installment.amount, installment.debt_uuid])).rows;
    let card = null;
    if (installment.credit_card_id) [card] = (await client.query('UPDATE credit_cards SET current_debt=GREATEST(0,current_debt-$1) WHERE id=$2 RETURNING name,current_debt', [installment.amount, installment.credit_card_id])).rows;
    const debtPaid = Number(debt.outstanding_amount) === 0;
    if (debtPaid) await client.query("UPDATE debts SET status='paid',closed_at=now() WHERE id=$1", [debt.id]);
    await client.query('COMMIT'); res.json({ ok: true, debt, debt_paid: debtPaid, card_paid: card ? Number(card.current_debt) === 0 : false, card_name: card?.name || null });
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo registrar el pago.') }); } finally { client.release(); }
});
app.patch('/income-projections/:month', auth, async (req, res) => {
  const month = `${req.params.month}`;
  const amount = Number(req.body?.amount);
  const currentMonth = dateText(new Date()).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || month <= currentMonth || !Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: 'Registra un ingreso estimado válido para un mes futuro.' });
  }
  const [projection] = await rows(
    `UPDATE users
     SET monthly_income_estimate=$1,updated_at=now()
     WHERE id=$2
     RETURNING monthly_income_estimate`,
    [amount, req.user.id],
  );
  res.json(projection);
});
app.get('/payment-planning', auth, async (req, res) => {
  const month = `${req.query.month || dateText(new Date()).slice(0, 7)}`;
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Mes inválido. Usa AAAA-MM.' });
  const [year, monthNumber] = month.split('-').map(Number); const monthIndex = monthNumber - 1;
  const todayKey = dateText(new Date()).slice(0, 7);
  const [scheduled, installments, accounts, investments, preferences] = await Promise.all([
    rows('SELECT * FROM scheduled_payments WHERE user_id=$1 AND is_active ORDER BY payment_day,name', [req.user.id]),
    rows(`SELECT i.id installment_id,i.due_date,i.amount,d.id debt_id,d.name,d.credit_card_id,cc.name credit_card_name
      FROM debt_installments i JOIN debts d ON d.id=i.debt_id LEFT JOIN credit_cards cc ON cc.id=d.credit_card_id
      WHERE d.user_id=$1 AND i.status IN ('pending','overdue') AND i.due_date >= $2::date AND i.due_date < ($2::date + interval '1 month')
      ORDER BY i.due_date,i.installment_number`, [req.user.id, `${month}-01`]),
    rows('SELECT id,name,current_balance FROM accounts WHERE user_id=$1 AND is_active ORDER BY name', [req.user.id]),
    rows("SELECT id,name,target_amount,current_amount,target_date FROM investments WHERE user_id=$1 AND status='active' AND target_amount IS NOT NULL AND target_date IS NOT NULL", [req.user.id]),
    rows('SELECT monthly_income_estimate FROM users WHERE id=$1', [req.user.id]),
  ]);
  const fixed = scheduled.flatMap((payment) => {
    const nextDueDate = dateText(new Date(payment.next_due_date));
    const nextKey = nextDueDate.slice(0, 7);
    const shouldInclude = month === todayKey ? nextKey === month : month > todayKey && (payment.frequency === 'monthly' || nextKey === month);
    if (!shouldInclude) return [];
    const dueDate = month === todayKey ? nextDueDate : dateText(atDay(year, monthIndex, Number(payment.payment_day)));
    return [{ id: payment.id, source: 'fixed', name: payment.name, amount: Number(payment.amount), due_date: dueDate, account_id: payment.account_id, notes: payment.notes }];
  });
  const debtItems = installments.map((item) => ({ id: item.installment_id, installment_id: item.installment_id, debt_id: item.debt_id, source: item.credit_card_id ? 'card' : 'debt', name: item.credit_card_id ? `${item.credit_card_name}: ${item.name.replace(/^Compra [^:]+:\s*/, '')}` : item.name, amount: Number(item.amount), due_date: dateText(new Date(item.due_date)), credit_card_name: item.credit_card_name }));
  const investmentItems = investments.flatMap((investment) => {
    const targetDate = dateFrom(investment.target_date);
    const targetMonth = targetDate.getFullYear() * 12 + targetDate.getMonth();
    const selectedMonth = year * 12 + monthIndex;
    const remaining = Math.max(0, Number(investment.target_amount) - Number(investment.current_amount));
    if (remaining <= 0 || selectedMonth > targetMonth) return [];
    const monthsLeft = Math.max(1, targetMonth - selectedMonth + 1);
    const amount = Math.ceil(remaining / monthsLeft);
    return [{ id: `investment-${investment.id}-${month}`, investment_id: investment.id, source: 'investment', name: `Meta: ${investment.name}`, amount, due_date: dateText(atDay(year, monthIndex, Math.min(targetDate.getDate(), 30))), notes: `Aporte sugerido para alcanzar la meta el ${dateText(targetDate)}` }];
  });
  const items = [...fixed, ...debtItems, ...investmentItems].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const groups = { up_to_15: items.filter((item) => Number(item.due_date.slice(8, 10)) <= 15), after_15: items.filter((item) => Number(item.due_date.slice(8, 10)) > 15) };
  const sum = (list) => list.reduce((total, item) => total + item.amount, 0);
  const account_totals = accounts.map((account) => {
    const fixedTotal = sum(fixed.filter((item) => item.account_id === account.id));
    return { id: account.id, name: account.name, balance: Number(account.current_balance), fixed_total: fixedTotal, projected_balance: Number(account.current_balance) - fixedTotal };
  });
  const isProjection = month > todayKey;
  const projectedIncome = isProjection && preferences[0]?.monthly_income_estimate != null
    ? Number(preferences[0].monthly_income_estimate)
    : null;
  res.json({ month, is_projection: isProjection, projected_income: projectedIncome, items, groups, total: sum(items), up_to_15_total: sum(groups.up_to_15), after_15_total: sum(groups.after_15), account_totals });
});
app.patch('/accounts/:id', auth, async (req, res) => {
  const allowed = ['name', 'type', 'institution', 'current_balance', 'color', 'is_active', 'account_number', 'holder_name', 'branch', 'contact_phone', 'address', 'notes']; const entries = allowed.filter((key) => Object.hasOwn(req.body, key));
  if (!entries.length) return res.status(400).json({ error: 'No hay cambios para guardar' });
  const [account] = await rows(`UPDATE accounts SET ${entries.map((key, index) => `${key}=$${index + 1}`).join(',')} WHERE id=$${entries.length + 1} AND user_id=$${entries.length + 2} RETURNING *`, [...entries.map((key) => req.body[key]), req.params.id, req.user.id]);
  if (!account) return res.status(404).json({ error: 'Cuenta no encontrada' }); res.json(account);
});
app.delete('/accounts/:id', auth, async (req, res) => {
  const client = await connect();
  try {
    await client.query('BEGIN');
    const { rows: [account] } = await client.query('SELECT id FROM accounts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!account) throw clientError('Cuenta no encontrada');
    await client.query('UPDATE scheduled_payments SET account_id=NULL WHERE user_id=$1 AND account_id=$2', [req.user.id, account.id]);
    await client.query('UPDATE investment_contributions SET account_id=NULL WHERE account_id=$1', [account.id]);
    await client.query('UPDATE transactions SET account_id=NULL WHERE user_id=$1 AND account_id=$2', [req.user.id, account.id]);
    await client.query('DELETE FROM accounts WHERE id=$1 AND user_id=$2', [account.id, req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, preserved_history: true });
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo eliminar la cuenta.') }); } finally { client.release(); }
});

app.get('/reports/monthly', auth, async (req, res) => {
  try { res.json(await reportMonth(req.user.id, req.query.month || dateText(new Date()).slice(0, 7))); }
  catch (error) { res.status(400).json({ error: safeError(error, 'No se pudo generar el informe.') }); }
});

app.get('/reports/monthly.xlsx', auth, async (req, res) => {
  try {
    const report = await reportMonth(req.user.id, req.query.month || dateText(new Date()).slice(0, 7));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Symplia Finanzas';
    const summary = workbook.addWorksheet('Resumen');
    summary.columns = [{ header: 'Indicador', key: 'label', width: 32 }, { header: 'Valor', key: 'value', width: 20 }];
    summary.addRows([
      { label: `Informe mensual ${report.month}`, value: '' },
      { label: 'Ingresos', value: report.income }, { label: 'Gastos', value: report.expense },
      { label: 'Resultado del mes', value: report.balance }, { label: 'Saldo en cuentas', value: report.total_balance },
      { label: 'Deuda en tarjetas', value: report.total_cards }, { label: 'Deudas activas', value: report.total_debt },
      { label: 'Inversiones y ahorros', value: report.total_investments },
    ]);
    summary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    summary.getColumn('value').numFmt = '$ #,##0';
    const transactions = workbook.addWorksheet('Movimientos');
    transactions.columns = [{ header: 'Fecha', key: 'date', width: 15 }, { header: 'Tipo', key: 'type', width: 14 }, { header: 'Categoría', key: 'category', width: 25 }, { header: 'Detalle', key: 'note', width: 42 }, { header: 'Valor', key: 'amount', width: 18 }];
    transactions.addRows(report.transactions.map((item) => ({ date: dateText(new Date(item.transaction_date)), type: item.type === 'income' ? 'Ingreso' : 'Gasto', category: item.category, note: item.note || '', amount: Number(item.amount) })));
    transactions.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; transactions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }; transactions.getColumn('amount').numFmt = '$ #,##0';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="informe-finanzas-${report.month}.xlsx"`);
    await workbook.xlsx.write(res); res.end();
  } catch (error) { res.status(400).json({ error: safeError(error, 'No se pudo exportar el informe.') }); }
});

app.get('/reports/monthly.pdf', auth, async (req, res) => {
  try {
    const report = await reportMonth(req.user.id, req.query.month || dateText(new Date()).slice(0, 7));
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="informe-finanzas-${report.month}.pdf"`);
    const pdf = new PDFDocument({ margin: 48, size: 'A4' }); pdf.pipe(res);
    pdf.fillColor('#1E3A5F').fontSize(22).text('Symplia Finanzas', { continued: true }).fillColor('#111827').text(`  Informe ${report.month}`);
    pdf.moveDown().fontSize(12).fillColor('#374151');
    [['Ingresos', report.income], ['Gastos', report.expense], ['Resultado del mes', report.balance], ['Saldo en cuentas', report.total_balance], ['Deuda en tarjetas', report.total_cards], ['Deudas activas', report.total_debt], ['Inversiones y ahorros', report.total_investments]].forEach(([label, value]) => pdf.text(`${label}: $ ${Number(value).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`));
    pdf.moveDown().fillColor('#1E3A5F').fontSize(15).text('Movimientos del mes'); pdf.moveDown(.4).fontSize(10).fillColor('#374151');
    report.transactions.slice(0, 22).forEach((item) => pdf.text(`${dateText(new Date(item.transaction_date))}  ·  ${item.type === 'income' ? 'Ingreso' : 'Gasto'}  ·  ${item.category}  ·  $ ${Number(item.amount).toLocaleString('es-CO', { maximumFractionDigits: 0 })}${item.note ? `\n${item.note}` : ''}`, { width: 500 }));
    if (report.transactions.length > 22) pdf.moveDown().text(`Se incluyen los primeros 22 de ${report.transactions.length} movimientos. El Excel contiene el detalle completo.`);
    pdf.end();
  } catch (error) { res.status(400).json({ error: safeError(error, 'No se pudo exportar el informe.') }); }
});
app.get('/investments', auth, async (req, res) => res.json(await rows(`SELECT i.*,COUNT(ic.id)::int contribution_count,MAX(ic.contribution_date) last_contribution_date FROM investments i LEFT JOIN investment_contributions ic ON ic.investment_id=i.id WHERE i.user_id=$1 GROUP BY i.id ORDER BY i.created_at DESC`, [req.user.id])));
app.post('/investments', auth, async (req, res) => {
  const { name, type = 'other', target_amount, target_date, start_date, notes, color = '#7C3AED', initial_amount = 0, account_id } = req.body;
  const target = target_amount == null ? null : Number(target_amount); const initial = Number(initial_amount);
  if (!name?.trim() || !['real_estate', 'stock', 'fund', 'business', 'other'].includes(type) || !Number.isFinite(initial) || initial < 0 || (target != null && (!Number.isFinite(target) || target < 0))) return res.status(400).json({ error: 'Datos de ahorro o inversión inválidos' });
  const client = await connect();
  try {
    await client.query('BEGIN');
    let transactionId = null;
    if (account_id && initial > 0) {
      const [account] = (await client.query('SELECT id FROM accounts WHERE id=$1 AND user_id=$2 AND is_active', [account_id, req.user.id])).rows;
      if (!account) throw clientError('Cuenta de origen inválida');
      const [transaction] = (await client.query("INSERT INTO transactions(user_id,account_id,type,amount,transaction_date,note) VALUES($1,$2,'transfer',$3,$4,$5) RETURNING id", [req.user.id, account_id, initial, start_date || dateText(new Date()), `Aporte inicial: ${name.trim()}`])).rows;
      transactionId = transaction.id;
      await client.query('UPDATE accounts SET current_balance=current_balance-$1 WHERE id=$2', [initial, account_id]);
    }
    const [investment] = (await client.query('INSERT INTO investments(user_id,name,type,target_amount,current_amount,start_date,target_date,notes,color) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [req.user.id, name.trim(), type, target, initial, start_date || dateText(new Date()), target_date || null, notes?.trim() || null, color])).rows;
    if (initial > 0) await client.query('INSERT INTO investment_contributions(investment_id,account_id,transaction_id,amount,contribution_date,note) VALUES($1,$2,$3,$4,$5,$6)', [investment.id, account_id || null, transactionId, initial, start_date || dateText(new Date()), 'Aporte inicial']);
    await client.query('COMMIT'); res.status(201).json(investment);
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo crear el ahorro o inversión.') }); } finally { client.release(); }
});
app.patch('/investments/:id', auth, async (req, res) => {
  const allowed = ['name', 'type', 'target_amount', 'start_date', 'target_date', 'notes', 'color', 'status']; const entries = allowed.filter((key) => Object.hasOwn(req.body, key));
  if (Object.hasOwn(req.body, 'start_date') && !validDate(dateFrom(req.body.start_date))) return res.status(400).json({ error: 'Fecha de inicio inválida' });
  if (Object.hasOwn(req.body, 'target_date') && req.body.target_date != null && !validDate(dateFrom(req.body.target_date))) return res.status(400).json({ error: 'Fecha final inválida' });
  if (!entries.length) return res.status(400).json({ error: 'No hay cambios para guardar' });
  const [investment] = await rows(`UPDATE investments SET ${entries.map((key, index) => `${key}=$${index + 1}`).join(',')} WHERE id=$${entries.length + 1} AND user_id=$${entries.length + 2} RETURNING *`, [...entries.map((key) => req.body[key]), req.params.id, req.user.id]);
  if (!investment) return res.status(404).json({ error: 'Ahorro o inversión no encontrado' }); res.json(investment);
});
app.delete('/investments/:id', auth, async (req, res) => {
  const { rowCount } = await query('DELETE FROM investments WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: 'Ahorro o inversión no encontrado' });
  res.json({ ok: true, preserved_history: true });
});
app.get('/investments/:id/contributions', auth, async (req, res) => res.json(await rows(`SELECT ic.*,a.name account_name FROM investment_contributions ic JOIN investments i ON i.id=ic.investment_id LEFT JOIN accounts a ON a.id=ic.account_id WHERE ic.investment_id=$1 AND i.user_id=$2 ORDER BY ic.contribution_date DESC,ic.created_at DESC`, [req.params.id, req.user.id])));
app.post('/investments/:id/contributions', auth, async (req, res) => {
  const { amount, contribution_date, note, account_id } = req.body; const value = Number(amount); const date = contribution_date || dateText(new Date());
  if (!Number.isFinite(value) || value <= 0 || !validDate(dateFrom(date))) return res.status(400).json({ error: 'Aporte inválido' });
  const client = await connect();
  try {
    await client.query('BEGIN');
    const [investment] = (await client.query('SELECT * FROM investments WHERE id=$1 AND user_id=$2 AND status=\'active\' FOR UPDATE', [req.params.id, req.user.id])).rows;
    if (!investment) throw clientError('Ahorro o inversión no encontrado');
    let transactionId = null;
    if (account_id) {
      const [account] = (await client.query('SELECT id FROM accounts WHERE id=$1 AND user_id=$2 AND is_active', [account_id, req.user.id])).rows;
      if (!account) throw clientError('Cuenta de origen inválida');
      const [transaction] = (await client.query("INSERT INTO transactions(user_id,account_id,type,amount,transaction_date,note) VALUES($1,$2,'transfer',$3,$4,$5) RETURNING id", [req.user.id, account_id, value, date, `Aporte a ${investment.name}${note ? `: ${note}` : ''}`])).rows;
      transactionId = transaction.id;
      await client.query('UPDATE accounts SET current_balance=current_balance-$1 WHERE id=$2', [value, account_id]);
    }
    const [contribution] = (await client.query('INSERT INTO investment_contributions(investment_id,account_id,transaction_id,amount,contribution_date,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [investment.id, account_id || null, transactionId, value, date, note?.trim() || null])).rows;
    await client.query('UPDATE investments SET current_amount=current_amount+$1 WHERE id=$2', [value, investment.id]);
    await client.query('COMMIT'); res.status(201).json(contribution);
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo registrar el aporte.') }); } finally { client.release(); }
});
app.patch('/scheduled_payments/:id/pay', auth, async (req, res) => {
  const client = await connect();
  try { await client.query('BEGIN'); const [p] = (await client.query('SELECT * FROM scheduled_payments WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows; if (!p) throw clientError('Pago no encontrado'); const accountId = req.body?.account_id || p.account_id; if (!accountId) throw clientError('Selecciona una cuenta para pagar'); const [account] = (await client.query('SELECT id FROM accounts WHERE id=$1 AND user_id=$2 AND is_active', [accountId, req.user.id])).rows; if (!account) throw clientError('Cuenta de pago inválida'); await client.query('INSERT INTO scheduled_payment_history(scheduled_payment_id,amount) VALUES($1,$2)', [p.id, p.amount]); await client.query("INSERT INTO transactions(user_id,account_id,category_id,type,amount,transaction_date,note) VALUES($1,$2,$3,'expense',$4,current_date,$5)", [req.user.id, accountId, p.category_id, p.amount, `Pago programado: ${p.name}`]); await client.query('UPDATE accounts SET current_balance=current_balance-$1 WHERE id=$2 AND user_id=$3', [p.amount, accountId, req.user.id]); await client.query("UPDATE scheduled_payments SET next_due_date=(next_due_date + interval '1 month')::date WHERE id=$1", [p.id]); await client.query('COMMIT'); res.json({ ok: true }); } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo registrar el pago.') }); } finally { client.release(); }
});
app.patch('/scheduled_payments/:id', auth, async (req, res) => {
  const { account_id, category_id, name, amount, payment_day, next_due_date, frequency, notes, is_active } = req.body;
  const value = Number(amount); const day = Number(payment_day);
  if (!name?.trim() || !Number.isFinite(value) || value <= 0 || ![15, 30].includes(day) || !validDate(dateFrom(next_due_date)) || !['monthly', 'once'].includes(frequency)) return res.status(400).json({ error: 'Datos del pago fijo inválidos' });
  const client = await connect();
  try {
    await client.query('BEGIN');
    const { rows: [exists] } = await client.query('SELECT id FROM scheduled_payments WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!exists) throw clientError('Pago fijo no encontrado');
    await ensureOwnedReference(client, 'accounts', account_id, req.user.id, 'Cuenta');
    await ensureOwnedReference(client, 'categories', category_id, req.user.id, 'Categoría', 'expense');
    const { rows: [payment] } = await client.query('UPDATE scheduled_payments SET account_id=$1,category_id=$2,name=$3,amount=$4,payment_day=$5,next_due_date=$6,frequency=$7,notes=$8,is_active=$9 WHERE id=$10 AND user_id=$11 RETURNING *', [account_id || null, category_id || null, name.trim(), value, day, next_due_date, frequency, notes?.trim() || null, is_active !== false, req.params.id, req.user.id]);
    await client.query('COMMIT');
    res.json(payment);
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: safeError(error, 'No se pudo actualizar el pago fijo.') }); } finally { client.release(); }
});
app.delete('/scheduled_payments/:id', auth, async (req, res) => {
  const { rowCount } = await query('DELETE FROM scheduled_payments WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: 'Pago fijo no encontrado' });
  res.json({ ok: true, preserved_history: true });
});

app.use((error, _, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.status === 403) return res.status(403).json({ error: 'Origen no permitido.' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud supera el tamaño permitido.' });
  console.error('Error de API:', error?.message || error);
  return res.status(500).json({ error: 'Ocurrió un error interno. Intenta nuevamente.' });
});

// En Vercel Express se ejecuta como función serverless; en local conserva el
// servidor HTTP tradicional para `npm run start`.
if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`API on http://localhost:${port}`));
}

export default app;
