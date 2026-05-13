const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { data } = await supabase
    .from('strava_tokens')
    .select('athlete_name, athlete_id')
    .limit(1)
    .single();
  res.json({ connected: !!data, athlete: data?.athlete_name || null });
};