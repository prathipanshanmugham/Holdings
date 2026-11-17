// Copy to config.js on the server and fill in from Supabase → Project Settings → API Keys.
window.HQ_CONFIG = {
  supabaseUrl: "",          // e.g. https://abcdefgh.supabase.co
  supabaseAnonKey: "",      // the publishable key (sb_publishable_…): safe in browsers, the database rules protect the data
  narrateUrl: "",           // optional: https://abcdefgh.supabase.co/functions/v1/narrate (empty hides the CFO desk)
  idleMinutes: 60           // sign out after this many minutes without activity
};
