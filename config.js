// Supabase configuration. Committed on purpose: the anon key is public and Row
// Level Security is what protects the data. Access is limited to the email
// addresses in the `members` table, so this key on its own grants nothing.
// Leave all values empty to run the app in local-only mode (no login,
// localStorage persistence only).
window.DUO_CONFIG = {
  supabaseUrl: 'https://qnhmpcropfqkorvltpmx.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFuaG1wY3JvcGZxa29ydmx0cG14Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NTUyMzIsImV4cCI6MjEwMzQzMTIzMn0.DJH8w9eJQTNgR7B6QTxIHzZR3yb8sLWtcS9kXrWQsRs'
};
