const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function stravaGet(endpoint, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.strava.com',
      path: '/api/v3' + endpoint,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function stravaActivityToRide(a) {
  const avgPower = a.average_watts || null;
  const np = a.weighted_average_watts || (avgPower ? Math.round(avgPower * 1.05) : null);
  return {
    strava_id: a.id.toString(),
    name: a.name || 'Cycling ride',
    date: a.start_date_local?.split('T')[0],
    dur: Math.round((a.moving_time || 0) / 60),
    dist: Math.round((a.distance || 0) / 100) / 10,
    elev: Math.round(a.total_elevation_gain || 0),
    avg_power: avgPower,
    np: np,
    max_power: a.max_watts || null,
    avg_hr: a.average_heartrate || null,
    max_hr: a.max_heartrate || null,
    cad: a.average_cadence || null,
    completed: true,
    strava_url: `https://www.strava.com/activities/${a.id}`,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { data: tokenRow } = await supabase
      .from('strava_tokens')
      .select('*')
      .limit(1)
      .single();

    if (!tokenRow) return res.status(400).json({ error: 'Strava not connected' });

    const activities = await stravaGet(
      '/athlete/activities?per_page=30&page=1',
      tokenRow.access_token
    );

    const cyclingTypes = ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide', 'EBikeRide'];
    const rides = activities
      .filter(a => cyclingTypes.includes(a.type))
      .map(a => stravaActivityToRide(a));

    if (rides.length) {
      await supabase.from('rides').upsert(rides, { onConflict: 'strava_id' });
    }

    res.json({ synced: rides.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};