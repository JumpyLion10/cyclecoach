const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('ftp_history')
      .select('*')
      .order('date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  if (req.method === 'POST') {
    const { ftp, date } = req.body;
    const { error } = await supabase
      .from('ftp_history')
      .insert({ ftp, date: date || new Date().toISOString().split('T')[0] });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ saved: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};