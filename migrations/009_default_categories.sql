INSERT INTO categories(user_id,name,type,icon,color)
SELECT u.id, defaults.name, defaults.type, defaults.icon, defaults.color
FROM users u
CROSS JOIN (
  VALUES
    ('Salario', 'income', 'salary', '#1E3A5F'),
    ('Ingresos extra', 'income', 'salary', '#4F7CAC'),
    ('Freelance', 'income', 'salary', '#1E3A5F'),
    ('Rendimientos', 'income', 'salary', '#4F7CAC'),
    ('Reembolsos', 'income', 'category', '#1E3A5F'),
    ('Vivienda', 'expense', 'home', '#1E3A5F'),
    ('Alimentación', 'expense', 'food', '#EA580C'),
    ('Transporte', 'expense', 'car', '#4F7CAC'),
    ('Servicios públicos', 'expense', 'home', '#1E3A5F'),
    ('Salud', 'expense', 'health', '#DC2626'),
    ('Educación', 'expense', 'education', '#7C3AED'),
    ('Entretenimiento', 'expense', 'category', '#4F7CAC'),
    ('Compras personales', 'expense', 'shopping', '#EA580C'),
    ('Deudas y créditos', 'expense', 'category', '#1E3A5F'),
    ('Suscripciones', 'expense', 'category', '#4F7CAC'),
    ('Mascotas', 'expense', 'category', '#EA580C'),
    ('Impuestos', 'expense', 'category', '#DC2626'),
    ('Ahorro e inversión', 'expense', 'category', '#1E3A5F'),
    ('Otros gastos', 'expense', 'category', '#64748B')
) AS defaults(name,type,icon,color)
ON CONFLICT(user_id,name,type) DO NOTHING;
