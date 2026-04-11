import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

// ── Auth guard ────────────────────────────────────────────────
// JWT is stored in localStorage after login/signup.
// Any protected route redirects to /login when no token is present.
function RequireAuth({ children }) {
  const token = localStorage.getItem('token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

// ── Placeholder screens ───────────────────────────────────────
// No UI built yet — each screen is a labelled stub.
// Replace these with real implementations one at a time.

function SignupPage()    { return <div>Signup</div>; }
function LoginPage()     { return <div>Login</div>; }

// Inbox: two tabs (Friends | Randoms) + Randoms toggle + bottom bar
// Spec: "Top: Randoms toggle (ON/OFF) — always visible"
//       "Top: Two tabs — Friends | Randoms"
//       "Bottom bar: Chat icon (new random) + Settings icon"
function InboxPage()     { return <div>Inbox</div>; }

// Direct message conversation with another user
function ChatPage()      { return <div>Chat</div>; }

// Group conversation
function GroupChatPage() { return <div>Group Chat</div>; }

// Own profile: display name, age range, gender, location,
// profile pictures (up to 10, swipeable gallery)
function ProfilePage()   { return <div>Profile</div>; }

// Settings: age/gender/location filters, block/ignore list,
// randoms toggle, burn-after-read timer, subscription/diamonds
function SettingsPage()  { return <div>Settings</div>; }

// ── App ───────────────────────────────────────────────────────
export default function App() {
  return (
    <BrowserRouter basename="/app">
      <Routes>
        {/* Public routes */}
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/login"  element={<LoginPage />} />

        {/* Protected routes */}
        <Route path="/" element={
          <RequireAuth><InboxPage /></RequireAuth>
        } />
        <Route path="/chat/:userId" element={
          <RequireAuth><ChatPage /></RequireAuth>
        } />
        <Route path="/chat/group/:groupId" element={
          <RequireAuth><GroupChatPage /></RequireAuth>
        } />
        <Route path="/profile" element={
          <RequireAuth><ProfilePage /></RequireAuth>
        } />
        <Route path="/settings" element={
          <RequireAuth><SettingsPage /></RequireAuth>
        } />

        {/* Fallback: unknown paths go to inbox (or login if unauthed) */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
