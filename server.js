// ─────────────────────────────────────────────
// CycleCoach AI — Backend Server
// Receives Garmin webhooks + serves the app
// ─────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// Connect to Supabase database
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serves your HTML app

// ─── HEALTH CHECK ────────────────────────────
// Visit /ping in your browser to confirm server is running
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', message: 'CycleCoach server is running' });
});

// ─── GARMIN WEBHOOK ──────────────────────────
// Garmin calls this URL every time you finish a ride
// You set this URL in the Garmin Health API dashboard
app.post('/garmin-webhook', async (req, res) => {
  console.log('📡 Garmin webhook received');

  try {
    const activities = req.body.activities || [];

    for (const activity of activities) {
      // Only process cycling activities
      const cyclingTypes = ['cycling', 'road_biking', 'mountain_biking', 'indoor_cycling', 'virtual_ride'];
      const type = (activity.activityType || '').toLowerCase();
      if (!cyclingTypes.some(t => type.includes(t))) {
        console.log(`Skipping non-cycling activity: ${activity.activityType}`);
        continue;
      }

      const ride = {
        garmin_id:    activity.activityId?.toString(),
        name:         activity.activityName || 'Cycling ride',
        date:         activity.startTimeLocal?.split('T')[0] || new Date().toISOString().split('T')[0],
        duration_min: Math.round((activity.duration || 0) / 60),
        distance_km:  Math.round((activity.distance || 0) / 1000 * 10) / 10,
        avg_power:    activity.avgPower     || null,
        np:           activity.normPower    || null,
        max_power:    activity.maxPower     || null,
        avg_hr:       activity.avgHr        || null,
        max_hr:       activity.maxHr        || null,
        avg_cadence:  activity.avgCadence   || null,
        elevation_m:  Math.round(activity.elevationGain || 0),
        tss:          activity.trainingStressScore || calculateTSS(activity),
        completed:    true,
      };

      // Save to Supabase — upsert means "insert, or update if already exists"
      const { error } = await supabase
        .from('rides')
        .upsert(ride, { onConflict: 'garmin_id' });

      if (error) {
        console.error('Database error:', error.message);
      } else {
        console.log(`✅ Saved ride: ${ride.name} on ${ride.date}`);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── API: GET ALL RIDES ───────────────────────
// The app fetches rides from here
app.get('/api/rides', async (req, res) => {
  const { data, error } = await supabase
    .from('rides')
    .select('*')
    .order('date', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── API: MARK SESSION AS MISSED ─────────────
app.post('/api/rides/missed', async (req, res) => {
  const { date, name, reason } = req.body;

  const { data, error } = await supabase
    .from('rides')
    .insert({
      name:      name || 'Planned session',
      date:      date,
      completed: false,
      missed_reason: reason,
    });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── API: SAVE FTP ────────────────────────────
app.post('/api/ftp', async (req, res) => {
  const { ftp, date } = req.body;

  const { error } = await supabase
    .from('ftp_history')
    .insert({ ftp, date: date || new Date().toISOString().split('T')[0] });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ saved: true });
});

// ─── API: GET FTP HISTORY ─────────────────────
app.get('/api/ftp', async (req, res) => {
  const { data, error } = await supabase
    .from('ftp_history')
    .select('*')
    .order('date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── HELPER: Estimate TSS if Garmin doesn't send it ──
function calculateTSS(activity) {
  if (!activity.avgPower || !activity.duration) return null;
  const assumedFTP = 220; // fallback FTP in watts
  const intensityFactor = activity.normPower
    ? activity.normPower / assumedFTP
    : activity.avgPower / assumedFTP;
  const hours = activity.duration / 3600;
  return Math.round(intensityFactor * intensityFactor * hours * 100);
}

// ─── START SERVER ─────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚴 CycleCoach server running`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Ping:   http://localhost:${PORT}/ping\n`);
});
