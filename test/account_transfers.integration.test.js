import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/db.js';

test('una transferencia mueve ambos saldos, queda en el historial y respeta al usuario', async () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const sourceId = randomUUID();
  const destinationId = randomUUID();
  const foreignId = randomUUID();
  const ids = [userId, otherUserId];
  let server;
  try {
    await query(
      `INSERT INTO users(id,name,email,password_hash) VALUES
       ($1,'Prueba de transferencia',$2,'prueba'),
       ($3,'Otro usuario',$4,'prueba')`,
      [userId, `transfer-${userId}@example.invalid`, otherUserId, `transfer-${otherUserId}@example.invalid`],
    );
    await query(
      `INSERT INTO accounts(id,user_id,name,type,current_balance) VALUES
       ($1,$2,'Origen','bank',100000),
       ($3,$2,'Destino','wallet',5000),
       ($4,$5,'Cuenta ajena','bank',7000)`,
      [sourceId, userId, destinationId, foreignId, otherUserId],
    );

    process.env.VERCEL = '1';
    const { default: app } = await import('../src/server.js');
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign(
      { id: userId, email: `transfer-${userId}@example.invalid` },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', issuer: 'symplia-finanzas', audience: 'symplia-client' },
    );
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const post = (body) => fetch(`${base}/account-transfers`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    const response = await post({
      source_account_id: sourceId,
      destination_account_id: destinationId,
      amount: '25000.50',
      note: 'Prueba automática',
    });
    assert.equal(response.status, 201, await response.text());
    const saved = await query('SELECT type,is_account_transfer,amount FROM transactions WHERE user_id=$1', [userId]);
    assert.equal(saved.rows.length, 1);
    assert.equal(saved.rows[0].type, 'transfer');
    assert.equal(saved.rows[0].is_account_transfer, true);
    assert.equal(saved.rows[0].amount, '25000.50');
    const balances = await query('SELECT id,current_balance FROM accounts WHERE id=ANY($1::uuid[])', [[sourceId, destinationId]]);
    assert.deepEqual(Object.fromEntries(balances.rows.map(({ id, current_balance }) => [id, current_balance])), {
      [sourceId]: '74999.50', [destinationId]: '30000.50',
    });

    const foreign = await post({ source_account_id: sourceId, destination_account_id: foreignId, amount: 100 });
    assert.equal(foreign.status, 400);
    const insufficient = await post({ source_account_id: sourceId, destination_account_id: destinationId, amount: 999999 });
    assert.equal(insufficient.status, 400);
    const transferList = await fetch(`${base}/account-transfers`, { headers });
    assert.equal((await transferList.json()).length, 1);

    const removal = await fetch(`${base}/accounts/${destinationId}`, { method: 'DELETE', headers });
    assert.equal(removal.status, 200, await removal.text());
    const preserved = await fetch(`${base}/account-transfers`, { headers });
    assert.equal((await preserved.json()).length, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await query('DELETE FROM transactions WHERE user_id=ANY($1::uuid[])', [ids]);
    await query('DELETE FROM accounts WHERE user_id=ANY($1::uuid[])', [ids]);
    await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
    await pool.end();
  }
});
