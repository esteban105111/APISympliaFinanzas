import bcrypt from 'bcryptjs';
import { pool } from './db.js';
const email = 'demo@finanzas.local';
try {
  const existing = (await pool.query('SELECT id FROM users WHERE email=$1',[email])).rows[0];
  if (existing) { console.log('Usuario demo ya existe:', email); process.exit(0); }
  const user = (await pool.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id',['Usuario Demo',email,await bcrypt.hash('demo1234',10)])).rows[0];
  const account = (await pool.query("INSERT INTO accounts(user_id,name,type,institution,current_balance,color) VALUES($1,'Cuenta principal','bank','Bancolombia',2450000,'#0F766E') RETURNING id",[user.id])).rows[0];
  const expense = (await pool.query("INSERT INTO categories(user_id,name,type,icon,color) VALUES($1,'Alimentación','expense','restaurant','#EF4444') RETURNING id",[user.id])).rows[0];
  const income = (await pool.query("INSERT INTO categories(user_id,name,type,icon,color) VALUES($1,'Salario','income','payments','#16A34A') RETURNING id",[user.id])).rows[0];
  await pool.query("INSERT INTO transactions(user_id,account_id,category_id,type,amount,transaction_date,note) VALUES($1,$2,$3,'income',4200000,current_date,'Salario mensual'),($1,$2,$4,'expense',185000,current_date,'Mercado')",[user.id,account.id,income.id,expense.id]);
  await pool.query("INSERT INTO debts(user_id,name,original_amount,outstanding_amount,total_installments,payment_day) VALUES($1,'Crédito de libre inversión',12000000,7200000,24,15)",[user.id]);
  await pool.query("INSERT INTO credit_cards(user_id,name,issuer,credit_limit,current_debt,closing_day,due_day) VALUES($1,'Visa Clásica','Bancolombia',5000000,1250000,25,10)",[user.id]);
  await pool.query("INSERT INTO investments(user_id,name,type,target_amount,current_amount,notes) VALUES($1,'Apartamento La Floresta','real_estate',80000000,22500000,'Cuota inicial')",[user.id]);
  await pool.query("INSERT INTO scheduled_payments(user_id,account_id,category_id,name,amount,payment_day,next_due_date) VALUES($1,$2,$3,'Administración',350000,15,date_trunc('month',current_date)::date+14),($1,$2,$3,'Internet hogar',110000,30,date_trunc('month',current_date)::date+29)",[user.id,account.id,expense.id]);
  console.log('Usuario demo creado: demo@finanzas.local / demo1234');
} finally { await pool.end(); }
