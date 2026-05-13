const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .order('date', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  if (req.method === 'POST') {
    const { date, name, reason } = req.body;
    const { data, error } = await supabase
      .from('rides')
      .insert({ name: name || 'Planned session', date, completed: false, missed_reason: reason });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  res.status(405).json({ error: 'Method not allowed' });
};