import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { getSuggestions } from './suggestions.js';
import { DEMO_MENTORS, DEMO_CONVERSATIONS, DEMO_SESSIONS, DEMO_NOTIFICATIONS, DEMO_ACTIVITY, DEMO_CHAT_MESSAGES } from './demoData.js';
import './styles.css';

const MATCHED_TEXT = 'You have been matched with a mentor.';
const TAGS = ['Data Structures', 'Operating Systems', 'DBMS', 'Web Development', 'Placement Prep', 'Computer Networks', 'Python', 'Java', 'Machine Learning', 'UI/UX Design'];
const EXPERTISE = ['beginner', 'intermediate', 'advanced'];
const TOPIC_TYPES = ['academic', 'career', 'wellbeing'];

const INDIAN_MENTEE_ALIASES = [
  'Chai Coder', 'Hostel Hero', 'Jugaad Junior', 'DSA Dost', 'Desi Dev',
  'Backbench Scholar', 'Placement Yatri', 'Campus Ninja', 'Byte Shishya',
  'Debug Dost', 'Code Yatri', 'Night Scholar', 'Algorithm Mitra', 'Sem Topper',
  'Library Hawk', 'Canteen Coder', 'Curious Panda', 'Logic Lynx'
];

const REPORT_REASONS = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'inappropriate_content', label: 'Inappropriate content' },
  { value: 'safety_concern', label: 'Safety concern' },
  { value: 'spam', label: 'Spam or off-topic' },
  { value: 'other', label: 'Something else' }
];

const MAX_GROUP_CAPACITY = 5;
const SERVER_URL = import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin);
const socket = io(SERVER_URL, { autoConnect: false, withCredentials: true });

const SESSION_KEY = 'maskchat-active-session';
function readSavedSession() {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clearSavedSession() {
  window.sessionStorage.removeItem(SESSION_KEY);
}

/* ──────────────────── Sound Synthesis (Web Audio) ──────────────────── */
function playChatSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {}
}

/* ──────────────────── Anonymous Name & Avatar Generator ──────────────────── */
function hashSeed(value) {
  let h = 2166136261;
  for (const char of String(value || 'maskchat')) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function getRandomIndianAlias() {
  return INDIAN_MENTEE_ALIASES[Math.floor(Math.random() * INDIAN_MENTEE_ALIASES.length)];
}

function generateAlias(seed) {
  if (!seed) return getRandomIndianAlias();
  const h = hashSeed(seed);
  return INDIAN_MENTEE_ALIASES[h % INDIAN_MENTEE_ALIASES.length];
}

const AVATAR_COLORS = ['#0b7b9e', '#3c6e71', '#72b89a', '#5b8fb9', '#7a6fb0', '#b08a5b'];
function MaskAvatar({ seed, size = 48 }) {
  const h = hashSeed(seed);
  const a = AVATAR_COLORS[h % 6];
  const b = AVATAR_COLORS[(h >>> 3) % 6];
  const shape = (h >>> 6) % 3;
  const rotate = ((h >>> 9) % 4) * 90;
  return (
    <svg className="mask-avatar" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="24" fill="var(--surface-3)" />
      <g transform={`rotate(${rotate} 24 24)`}>
        {shape === 0 && <><path d="M8 24a16 16 0 0 1 32 0z" fill={a} /><path d="M8 26a16 16 0 0 0 32 0z" fill={b} opacity=".75" /></>}
        {shape === 1 && <><path d="M24 8l16 28H8z" fill={a} /><circle cx="24" cy="27" r="6" fill={b} /></>}
        {shape === 2 && <><circle cx="24" cy="24" r="16" fill="none" stroke={a} strokeWidth="5" /><circle cx="24" cy="24" r="6" fill={b} /></>}
      </g>
      <circle cx="24" cy="24" r="23.5" fill="none" stroke="var(--line-strong)" />
    </svg>
  );
}

/* ──────────────────── Guided Demo Script & Peer Response Engine ──────────────────── */

const GUIDED_DEMO_TURNS = [
  "Namaste! Glad to connect anonymously. I'm Chai Coder from 3rd year. Let's work through Binary Trees & Recursion. Where is your traversal or node logic giving you trouble?",
  "Here is the key mental model: In a binary tree, every node is itself the root of a smaller subtree.\n\nYour recursive function only ever needs three simple steps:\n1. Base case: if (root == null) return;\n2. Action: process the current root value\n3. Recursive calls: traverse root.left and root.right\n\nAre you implementing Inorder (Left-Root-Right), Preorder, or Postorder traversal?",
  "Great question! Check out this clean traversal implementation in C++ / Java:\n\n```\nvoid inorder(TreeNode* root) {\n    if (root == nullptr) return; // Base case\n    inorder(root->left);         // 1. Visit left\n    cout << root->val << ' ';    // 2. Process root\n    inorder(root->right);        // 3. Visit right\n}\n```\nNotice we never check `root->left == null` before calling — the base case automatically handles empty children cleanly!",
  "For your semester exams and technical interviews, keep these two key points in mind:\n• Time Complexity: O(N) because every node is visited exactly once.\n• Space Complexity: O(H) where H is tree height (call stack). In a skewed tree, worst-case space is O(N), but for balanced trees it's O(log N).\n\nAlways mention both average and worst case in exams!",
  "You've got the concepts down solid! 🌟\n\nI recommend trying LeetCode #94 (Binary Tree Inorder Traversal) and #104 (Maximum Depth of Binary Tree) for practice. You can write down quick notes in the takeaways sidebar or click 'End session' when you're done!"
];

function getSmartPeerResponse(userText, topic = 'Data Structures', mentorAlias = 'Chai Coder', turnIndex = 0, isDemo = false) {
  if (isDemo && turnIndex < GUIDED_DEMO_TURNS.length) {
    return GUIDED_DEMO_TURNS[turnIndex];
  }

  const lower = userText.toLowerCase();

  if (lower.includes('recursion') || lower.includes('tree') || lower.includes('stack') || lower.includes('queue') || lower.includes('dsa') || lower.includes('graph')) {
    const dsaReplies = [
      `A great mental model for recursion is thinking about the base case first: when do you stop? Then trust the recursive step to solve the sub-problem. What specific case is giving you trouble?`,
      `For this data structure problem, trace through the call stack on paper with a tiny example (e.g. 3 nodes). It makes state transitions immediately obvious!`,
      `Remember edge cases: empty input (root is null), single element, and duplicate values. Are you implementing it iteratively with a Stack or recursively?`,
      `For graph and tree questions in exams, always mention whether you're using BFS (Queue, level by level) or DFS (Stack/Recursion, deep branch first).`
    ];
    return dsaReplies[turnIndex % dsaReplies.length];
  }

  if (lower.includes('deadlock') || lower.includes('thread') || lower.includes('process') || lower.includes('os') || lower.includes('memory') || lower.includes('paging')) {
    const osReplies = [
      `In Operating Systems, deadlocks happen when you have 4 conditions: mutual exclusion, hold and wait, no preemption, and circular wait. Breaking any single one prevents deadlock!`,
      `The key difference: a Process has its own isolated memory address space, while Threads inside the same process share heap memory and file handles but have private stacks.`,
      `For semester exams, scheduling algorithms (Round Robin, SJF) and page replacement (LRU, FIFO) usually carry the highest marks. Let me know if you want to trace an example!`
    ];
    return osReplies[turnIndex % osReplies.length];
  }

  if (lower.includes('react') || lower.includes('css') || lower.includes('web') || lower.includes('javascript') || lower.includes('frontend') || lower.includes('backend') || lower.includes('api')) {
    const webReplies = [
      `In React, always keep state as local as possible. If multiple sibling components need the same data, lift it up to their closest common parent!`,
      `For connecting frontend to Express/Node.js, make sure CORS is enabled and always handle loading and error states in your fetch/axios call.`,
      `Good CSS architecture makes a huge difference. Using CSS custom properties (variables) for colors and spacing keeps your UI cohesive and makes dark/light theme switching seamless!`
    ];
    return webReplies[turnIndex % webReplies.length];
  }

  if (lower.includes('interview') || lower.includes('resume') || lower.includes('placement') || lower.includes('career') || lower.includes('internship')) {
    const careerReplies = [
      `For on-campus placements, focus on mastering 75 core LeetCode problems rather than grinding 500 blindly. Being able to explain your thought process out loud matters most to interviewers!`,
      `On your resume, highlight project impact using the STAR format: Situation, Task, Action, Result. Quantifiable numbers always stand out.`,
      `Mock interviews helped me the most during placement season. Would you like to do a quick mock technical question together?`
    ];
    return careerReplies[turnIndex % careerReplies.length];
  }

  if (lower.includes('hi') || lower.includes('hello') || lower.includes('hey') || lower.includes('namaste')) {
    return `Hey there! Glad to connect anonymously. I've worked through a lot of ${topic} recently. What topic or assignment are you looking at right now?`;
  }

  if (lower.includes('thank') || lower.includes('thanks') || lower.includes('helpful') || lower.includes('got it') || lower.includes('understood')) {
    return `Awesome, glad that clicked! Feel free to ask if anything else comes up while you're coding.`;
  }

  const genericReplies = [
    `That's a solid question! The way I approached this last semester was breaking the logic into smaller testable helper functions first.`,
    `I ran into the exact same issue in my 2nd year! The trick was checking loop boundary conditions and edge cases with zero/null values.`,
    `Makes total sense. If you share a quick snippet of what you've tried so far, we can debug the exact line together!`,
    `Great line of thinking! Once you have the brute force working, we can look at optimizing the time complexity using a HashMap or Two Pointers.`
  ];
  return genericReplies[turnIndex % genericReplies.length];
}

/* ──────────────────── Utility Components ──────────────────── */

function Brand() {
  const institutionId = window.sessionStorage.getItem('maskchat-institution-id') || 'default';
  const logo = window.localStorage.getItem(`maskchat-brand-logo:${institutionId}`);
  return <a className="brand" href="#top" aria-label="MaskChat home">{logo ? <img className="brand-logo" src={logo} alt="Institution logo" /> : <span className="brand-mark">m</span>}<span>maskchat</span></a>;
}

function SkipLink({ label = 'Skip to main content' }) {
  return <a className="skip-link" href="#main-content">{label}</a>;
}

function ThemeToggle() {
  const [dark, setDark] = React.useState(() => {
    const saved = window.localStorage.getItem('maskchat-theme');
    return saved ? saved === 'dark' : true;
  });

  React.useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    window.localStorage.setItem('maskchat-theme', dark ? 'dark' : 'light');
  }, [dark]);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setDark((value) => !value)}
      aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
      title={`Switch to ${dark ? 'light' : 'dark'} mode`}
    >
      <span className="theme-icon" aria-hidden="true">{dark ? '☀' : '☾'}</span>
    </button>
  );
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MAX_SLOTS = 14;
function formatTimer(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = String(Math.floor(safe / 60)).padStart(2, '0');
  const sec = String(safe % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

function formatTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return String(value || '');
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}
function cleanSchedule(slots) {
  return slots.filter((slot) => slot.start && slot.end && slot.end > slot.start).map(({ day, start, end }) => ({ day, start, end }));
}

function ConnectionBadge({ state }) {
  const labels = { connected: 'Connected', reconnecting: 'Reconnecting…', lost: 'Connection lost' };
  return <span className={`conn conn-${state}`} role="status"><i aria-hidden="true" />{labels[state]}</span>;
}

function PrivacyGuard({ compact = false }) {
  return (
    <div className={compact ? 'privacy-guard compact' : 'privacy-guard'}>
      <span className="privacy-guard-icon" aria-hidden="true">🔒</span>
      <div><b>Privacy guard active</b>{!compact && <p>Personal details like phone numbers, emails and roll numbers are blocked automatically.</p>}</div>
    </div>
  );
}

function Toast({ message, kind = 'info' }) {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message ? <div className={`toast ${kind}`}>{message}</div> : null}
    </div>
  );
}

function Dialog({ labelledBy, onCancel, children }) {
  const dialogRef = React.useRef(null);
  const onCancelRef = React.useRef(onCancel);
  onCancelRef.current = onCancel;
  React.useEffect(() => {
    const previouslyFocused = document.activeElement;
    const node = dialogRef.current;
    const focusable = node?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusable?.[0]?.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape') { onCancelRef.current(); return; }
      if (event.key !== 'Tab' || !focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    node?.addEventListener('keydown', onKeyDown);
    return () => {
      node?.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);
  return (
    <div className="report-overlay" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={dialogRef}>
      {children}
    </div>
  );
}

/* ──────────────────── Change Mentee Alias Modal ──────────────────── */
function ChangeAliasModal({ currentAlias, onCancel, onSave }) {
  const [name, setName] = React.useState(currentAlias);
  return (
    <Dialog labelledBy="change-alias-title" onCancel={onCancel}>
      <form className="report-panel" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
        <p className="eyebrow">ANONYMOUS IDENTITY</p>
        <h2 id="change-alias-title">Choose your Mentee Alias</h2>
        <p className="muted">This name is shown to mentors and peers. It keeps your real name, email, and roll number completely hidden.</p>
        <label htmlFor="alias-input-modal">Campus Mentee Alias</label>
        <div className="alias-input-row">
          <input
            id="alias-input-modal"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Chai Coder, Hostel Hero"
            required
            maxLength={28}
          />
          <button type="button" className="secondary" onClick={() => setName(getRandomIndianAlias())} title="Pick random Indian alias">🎲 Random</button>
        </div>
        <p className="muted" style={{ marginTop: 10, marginBottom: 4 }}>Popular suggestions:</p>
        <div className="alias-quick-chips">
          {INDIAN_MENTEE_ALIASES.slice(0, 8).map(a => (
            <button key={a} type="button" className="alias-quick-chip" onClick={() => setName(a)}>{a}</button>
          ))}
        </div>
        <div className="report-actions" style={{ marginTop: 16 }}>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary report-submit">Save Alias <span aria-hidden="true">→</span></button>
        </div>
      </form>
    </Dialog>
  );
}

/* ──────────────────── Request Session Modal ──────────────────── */
function RequestSessionModal({ mentor, onCancel, onSubmit, demoMode = false }) {
  const [topic, setTopic] = React.useState(mentor.subjects?.[0] || 'Data Structures');
  const slots = Array.isArray(mentor.schedule) && mentor.schedule.length ? mentor.schedule : (demoMode ? [{ day: 6, start: '2:00 PM', end: '2:30 PM' }] : []);
  const [slotIndex, setSlotIndex] = React.useState(0);
  const [note, setNote] = React.useState('');
  const slot = slots[slotIndex] || null;
  const formatSlot = (item) => {
    if (!item) return 'No availability published';
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${days[Number(item.day) % 7]} · ${item.start}–${item.end}`;
  };

  return (
    <Dialog labelledBy="request-session-title" onCancel={onCancel}>
      <form className="report-panel" onSubmit={(e) => { e.preventDefault(); if (slot) onSubmit({ topic, note, peerAlias: mentor.alias, mentorRef: mentor.mentorRef, start: slot.start, end: slot.end }); }}>
        <p className="eyebrow">BOOK A SESSION</p>
        <h2 id="request-session-title">Request with {mentor.alias}</h2>
        <p className="muted">Book an anonymous 1:1 study session. Your identity remains completely private.</p>

        <label className="profile-field">
          Subject / Topic
          <select value={topic} onChange={e => setTopic(e.target.value)}>
            {(mentor.subjects || TAGS).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label className="profile-field">
          Available time
          <select value={slotIndex} onChange={e => setSlotIndex(Number(e.target.value))} disabled={!slots.length}>
            {slots.length ? slots.map((item, index) => <option key={`${item.day}-${item.start}-${item.end}`} value={index}>{formatSlot(item)}</option>) : <option>No availability published</option>}
          </select>
        </label>

        {!slots.length && <p className="muted">This mentor has not published a bookable time yet.</p>}

        <label className="profile-field">
          What do you need help with? (Optional)
          <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Need help with binary search trees or exam questions" />
        </label>

        <div className="report-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary report-submit">Send Request <span aria-hidden="true">→</span></button>
        </div>
      </form>
    </Dialog>
  );
}

/* ──────────────────── Mentor Profile Card ──────────────────── */

function MentorProfileCard({ card, compact = false, seed = 'mentor', onStartChat, onRequestSession }) {
  const level = card.expertise ? card.expertise.charAt(0).toUpperCase() + card.expertise.slice(1) : 'Intermediate';
  const line = [card.yearLabel, level].filter(Boolean).join(' · ');
  return (
    <div className={compact ? 'mentor-card compact' : 'mentor-card'}>
      <div className="mentor-card-head">
        <MaskAvatar seed={seed} size={compact ? 32 : 38} />
        <div className="mentor-card-info">
          <p className="mentor-card-title">{card.alias || 'Anonymous Mentor'}</p>
          {card.bio && !compact && <p className="mentor-bio">{card.bio}</p>}
        </div>
        {card.availableNow && <span className="online"><i aria-hidden="true" />Online</span>}
        {!card.availableNow && card.lastActive && !compact && <span className="offline-badge">{card.lastActive}</span>}
      </div>
      <ul className="session-tags" aria-label="Subjects">{(card.tags || card.subjects || []).map((tag) => <li key={tag}>{tag}</li>)}</ul>
      <p className="mentor-level">{line}<span className="mentor-sub"> · {card.topicType || 'academic'}</span></p>
      <div className="mentor-metrics">
        <span>{card.sessionsHosted > 0 ? `${card.sessionsHosted} session${card.sessionsHosted === 1 ? '' : 's'}` : 'New mentor'}</span>
        <span><span aria-hidden="true">👍</span> {card.helpful} helpful</span>
      </div>
      {card.badges?.length ? <div className="mentor-badges">{card.badges.map((badge) => <span key={badge}>★ {badge}</span>)}</div> : null}
      {(onStartChat || onRequestSession) && !compact && (
        <div className="mentor-card-actions">
          {card.availableNow && onStartChat && <button type="button" className="primary small-btn" onClick={() => onStartChat(card)}>Start chat</button>}
          {onRequestSession && <button type="button" className="secondary small-btn" onClick={() => onRequestSession(card)}>Request</button>}
        </div>
      )}
    </div>
  );
}

/* ──────────────────── Sidebar Navigation ──────────────────── */

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '⊞' },
  { id: 'discover', label: 'Discover', icon: '⊕' },
  { id: 'sessions', label: 'Sessions', icon: '◷' },
  { id: 'notifications', label: 'Notifications', icon: '⊘' },
  { id: 'profile', label: 'Profile', icon: '⊙' },
  { id: 'settings', label: 'Settings', icon: '⊛' },
];

function Sidebar({ screen, onNavigate, alias, unreadCount, onEditAlias }) {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main navigation">
      <div className="sidebar-top">
        <Brand />
        <button type="button" className="sidebar-toggle" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? '»' : '«'}
        </button>
      </div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`sidebar-item ${screen === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
            aria-current={screen === item.id ? 'page' : undefined}
          >
            <span className="sidebar-icon" aria-hidden="true">{item.icon}</span>
            {!collapsed && <span className="sidebar-label">{item.label}</span>}
            {item.id === 'notifications' && unreadCount > 0 && <span className="sidebar-badge">{unreadCount}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        {!collapsed && (
          <div className="sidebar-user" onClick={onEditAlias} title="Click to change alias">
            <MaskAvatar seed={alias} size={28} />
            <div>
              <p className="sidebar-alias">{alias} ✏️</p>
              <p className="sidebar-role">Mentee alias</p>
            </div>
          </div>
        )}
        <ThemeToggle />
      </div>
    </aside>
  );
}

function MobileNav({ screen, onNavigate, unreadCount }) {
  const items = NAV_ITEMS.slice(0, 5);
  return (
    <nav className="mobile-nav" aria-label="Main navigation">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`mobile-nav-item ${screen === item.id ? 'active' : ''}`}
          onClick={() => onNavigate(item.id)}
        >
          <span className="mobile-nav-icon" aria-hidden="true">{item.icon}</span>
          <span className="mobile-nav-label">{item.label}</span>
          {item.id === 'notifications' && unreadCount > 0 && <span className="mobile-nav-badge">{unreadCount}</span>}
        </button>
      ))}
    </nav>
  );
}

/* ──────────────────── Search Panel ──────────────────── */

function SearchPanel({ onNavigate, onStartChat, onOpenConversation, onClose, demoMode }) {
  const [query, setQuery] = React.useState('');
  const lq = query.toLowerCase();
  const mentorResults = demoMode && query.length >= 2 ? DEMO_MENTORS.filter(m => m.alias.toLowerCase().includes(lq) || m.subjects.some(s => s.toLowerCase().includes(lq)) || m.bio.toLowerCase().includes(lq)) : [];
  const topicResults = query.length >= 2 ? TAGS.filter(t => t.toLowerCase().includes(lq)) : [];
  const convResults = demoMode && query.length >= 2 ? DEMO_CONVERSATIONS.filter(c => c.peerAlias.toLowerCase().includes(lq) || c.topic.toLowerCase().includes(lq) || c.lastMessage.toLowerCase().includes(lq)) : [];
  const hasResults = mentorResults.length > 0 || topicResults.length > 0 || convResults.length > 0;

  return (
    <div className="search-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-panel">
        <div className="search-header">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="search"
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mentors, topics, conversations…"
            autoFocus
          />
          <button type="button" className="search-close" onClick={onClose} aria-label="Close search">✕</button>
        </div>
        <div className="search-results">
          {query.length < 2 && (
            <div className="search-hint">
              <p className="search-hint-title">Quick search</p>
              <div className="search-suggestions">
                {['Data Structures', 'Python', 'Placement Prep', 'Web Development'].map(s => (
                  <button key={s} type="button" className="search-suggestion-chip" onClick={() => setQuery(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {query.length >= 2 && !hasResults && (
            <div className="search-empty">
              <p>No results for "{query}"</p>
            </div>
          )}
          {mentorResults.length > 0 && (
            <div className="search-section">
              <p className="search-section-title">Mentors & Peers</p>
              {mentorResults.slice(0, 4).map(m => (
                <button key={m.id} type="button" className="search-result-item" onClick={() => { onStartChat(m); onClose(); }}>
                  <MaskAvatar seed={m.alias} size={28} />
                  <div>
                    <p className="search-result-name">{m.alias}</p>
                    <p className="search-result-meta">{m.subjects.join(', ')} · {m.availableNow ? 'Online' : 'Offline'}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
          {topicResults.length > 0 && (
            <div className="search-section">
              <p className="search-section-title">Topics</p>
              {topicResults.map(t => (
                <button key={t} type="button" className="search-result-item" onClick={() => { onNavigate('discover'); onClose(); }}>
                  <span className="search-result-topic-icon" aria-hidden="true">📚</span>
                  <div>
                    <p className="search-result-name">{t}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
          {convResults.length > 0 && (
            <div className="search-section">
              <p className="search-section-title">Conversations</p>
              {convResults.slice(0, 3).map(c => (
                <button key={c.id} type="button" className="search-result-item" onClick={() => { onOpenConversation(c); onClose(); }}>
                  <MaskAvatar seed={c.peerAlias} size={28} />
                  <div>
                    <p className="search-result-name">{c.peerAlias}</p>
                    <p className="search-result-meta">{c.lastMessage.slice(0, 45)}…</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ──────────────────── Ultra-Compact Modern Dashboard ──────────────────── */

function DashboardScreen({
  alias, onEditAlias, role, setRole, tags, setTags, onNavigate, onFindMentor, onTryDemo,
  onStartChatWithMentor, onOpenConversation, onOpenSessionChat,
  isMatching, matchError, setMatchError, requestMatch, isAvailable, setMentorAvailability,
  sessionsList, demoMode
}) {
  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  const onlineMentors = demoMode ? DEMO_MENTORS.filter(m => m.availableNow) : [];
  const recentConvos = demoMode ? DEMO_CONVERSATIONS.slice(0, 3) : [];
  const upcomingSessions = sessionsList.filter(s => s.status === 'upcoming').slice(0, 2);

  return (
    <section className="dashboard">
      {/* Top compact identity & stats bar */}
      <div className="dash-topbar-card">
        <div className="dash-user-identity">
          <MaskAvatar seed={alias} size={34} />
          <div>
            <h1>
              {greeting}, {alias}
              <button type="button" className="dash-edit-alias-btn" onClick={onEditAlias} title="Change your anonymous alias">✏️ Change</button>
            </h1>
            <p className="dash-subtitle">Anonymous Student Workspace</p>
          </div>
        </div>
        <div className="dash-inline-stats">
          <span className="stat-pill"><b>{demoMode ? DEMO_ACTIVITY.totalSessions : 0}</b> Sessions</span>
          <span className="stat-pill"><b>{demoMode ? DEMO_ACTIVITY.totalMessages : 0}</b> Messages</span>
          <span className="stat-pill"><b>{demoMode ? DEMO_ACTIVITY.helpfulCount : 0}</b> Helpful</span>
          <span className="stat-pill"><b>{onlineMentors.length}</b> Online now</span>
        </div>
      </div>

      {/* 2-Column Main Match & Actions Card */}
      <div className="dash-main-grid">
        <div className="dash-left-panel">
          <div className="role-grid-compact">
            <button type="button" className={`role-card-compact ${role === 'learner' ? 'selected' : ''}`} onClick={() => setRole('learner')}>
              <b>🎓 Need Mentor</b>
              <small>Ask questions</small>
            </button>
            <button type="button" className={`role-card-compact ${role === 'mentor' ? 'selected' : ''}`} onClick={() => setRole('mentor')}>
              <b>💡 Can Mentor</b>
              <small>Offer guidance</small>
            </button>
          </div>
          <div className="quick-actions-compact">
            <button type="button" className="quick-act-btn" onClick={onFindMentor}><span aria-hidden="true">💬</span> Find Mentor</button>
            <button type="button" className="quick-act-btn" onClick={() => onNavigate('discover')}><span aria-hidden="true">🔍</span> Browse Peers</button>
            <button type="button" className="quick-act-btn" onClick={() => onNavigate('sessions')}><span aria-hidden="true">📅</span> My Sessions</button>
            <button type="button" className="quick-act-btn" onClick={onTryDemo}><span aria-hidden="true">🎯</span> Try Demo</button>
          </div>
        </div>

        <div className="dash-match-box">
          <div className="match-box-head">
            <p className="match-box-title">{role === 'mentor' ? 'Your Expertise' : 'Choose Topic to Match'}</p>
            <span className="muted" style={{ fontSize: 11 }}>100% Anonymous</span>
          </div>
          <div className="tag-picker-compact">
            {TAGS.slice(0, 8).map(tag => (
              <button
                key={tag}
                type="button"
                className={`tag-compact ${tags.includes(tag) ? 'active' : ''}`}
                onClick={() => setTags(tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag].slice(0, 4))}
              >
                {tag}
              </button>
            ))}
          </div>
          <div className="match-actions-compact">
            {role === 'mentor' ? (
              <button className={isAvailable ? 'secondary active-status small-btn' : 'primary small-btn'} onClick={setMentorAvailability} style={{ width: '100%' }}>
                {isAvailable ? 'Available · Pause' : 'Go Available Now →'}
              </button>
            ) : (
              <>
                <button className="primary cta small-btn" onClick={() => requestMatch(false)} style={{ flex: 1 }}>
                  Find Mentor Now →
                </button>
                <button type="button" className="secondary small-btn" onClick={() => requestMatch(true)}>
                  Guided Demo
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 2-Column Split: Conversations & Upcoming Sessions */}
      <div className="dash-split-grid">
        <div className="dash-card-section">
          <div className="dash-section-head">
            <h2>Recent Conversations</h2>
            <button type="button" className="quiet-link" onClick={() => onNavigate('sessions')}>View all</button>
          </div>
          <div className="conv-list-compact">
            {recentConvos.map(c => (
              <div key={c.id} className="conv-item-compact" onClick={() => onOpenConversation(c)}>
                <MaskAvatar seed={c.peerAlias} size={28} />
                <div className="conv-info-compact">
                  <div className="conv-top-compact">
                    <span className="conv-name-compact">{c.peerAlias}</span>
                    <span className="conv-time-compact">{c.timestamp}</span>
                  </div>
                  <span className="conv-preview-compact">{c.lastMessage}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="dash-card-section">
          <div className="dash-section-head">
            <h2>Upcoming Sessions</h2>
            <button type="button" className="quiet-link" onClick={() => onNavigate('sessions')}>View all</button>
          </div>
          {upcomingSessions.length === 0 ? (
            <p className="muted" style={{ padding: '12px 0' }}>No upcoming sessions scheduled.</p>
          ) : (
            upcomingSessions.map(s => (
              <div key={s.id} className="session-item-compact">
                <div className="session-info-compact">
                  <span className="session-topic-compact">{s.topic}</span>
                  <span className="session-meta-compact">with {s.peerAlias} · {s.date}</span>
                </div>
                <button type="button" className="primary small-btn" onClick={() => onOpenSessionChat(s)}>Join</button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Available Mentors Preview */}
      <div className="dash-card-section">
        <div className="dash-section-head">
          <h2>Active Peers Available Now</h2>
          <button type="button" className="quiet-link" onClick={() => onNavigate('discover')}>See all {onlineMentors.length}</button>
        </div>
        <div className="dash-mentors-grid">
          {onlineMentors.slice(0, 3).map(m => (
            <MentorProfileCard key={m.id} card={m} seed={m.alias} onStartChat={() => onStartChatWithMentor(m)} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────── Discover Screen ──────────────────── */

function DiscoverScreen({ onStartChat, onRequestSession, demoMode }) {
  const [searchQ, setSearchQ] = React.useState('');
  const [filterSubject, setFilterSubject] = React.useState('all');
  const [filterAvailability, setFilterAvailability] = React.useState('all');
  const [sortBy, setSortBy] = React.useState('recommended');
  const [liveMentors, setLiveMentors] = React.useState([]);

  React.useEffect(() => {
    if (demoMode || !socket.connected) return undefined;
    const load = () => socket.emit('schedule:list', { tags: filterSubject === 'all' ? TAGS : [filterSubject], topicType: 'academic' }, (ack) => {
      if (ack?.ok) setLiveMentors((ack.mentors || []).map(item => ({ ...item.mentorCard, mentorRef: item.mentorRef, schedule: item.schedule || [], availableNow: false })));
    });
    load();
    socket.on('connect', load);
    return () => socket.off('connect', load);
  }, [demoMode, filterSubject]);

  let results = demoMode ? [...DEMO_MENTORS] : [...liveMentors];
  if (searchQ.length >= 2) {
    const lq = searchQ.toLowerCase();
    results = results.filter(m => m.alias.toLowerCase().includes(lq) || m.subjects.some(s => s.toLowerCase().includes(lq)) || m.bio.toLowerCase().includes(lq));
  }
  if (filterSubject !== 'all') results = results.filter(m => m.subjects.includes(filterSubject));
  if (filterAvailability === 'online') results = results.filter(m => m.availableNow);
  if (filterAvailability === 'offline') results = results.filter(m => !m.availableNow);
  if (sortBy === 'helpful') results.sort((a, b) => b.helpful - a.helpful);
  if (sortBy === 'sessions') results.sort((a, b) => b.sessionsHosted - a.sessionsHosted);
  if (sortBy === 'recommended') results.sort((a, b) => (b.availableNow ? 1 : 0) - (a.availableNow ? 1 : 0) || b.helpful - a.helpful);

  return (
    <section className="discover-page">
      <div className="page-header">
        <h1>Discover Mentors & Peers</h1>
        <p className="page-subtitle">Connect anonymously with campus peers who have worked through your courses.</p>
      </div>

      <div className="discover-controls">
        <div className="discover-search-wrap">
          <span className="discover-search-icon" aria-hidden="true">⌕</span>
          <input type="search" className="discover-search" value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search by name, subject, or skill…" />
        </div>
        <div className="discover-filters">
          <select value={filterSubject} onChange={e => setFilterSubject(e.target.value)} aria-label="Filter by subject">
            <option value="all">All subjects</option>
            {TAGS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={filterAvailability} onChange={e => setFilterAvailability(e.target.value)} aria-label="Filter by availability">
            <option value="all">All</option>
            <option value="online">Online now</option>
            <option value="offline">Offline</option>
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort by">
            <option value="recommended">Recommended</option>
            <option value="helpful">Most helpful</option>
            <option value="sessions">Most sessions</option>
          </select>
        </div>
      </div>

      <div className="discover-grid">
        {results.length === 0 ? <div className="empty-state"><h3>No live mentor directory</h3><p>Mentors are matched through the private queue. Use <b>Find Mentor Now</b> to request a match.</p></div> : results.map(m => (
          <MentorProfileCard key={m.id} card={m} seed={m.alias} onStartChat={() => onStartChat(m)} onRequestSession={() => onRequestSession(m)} />
        ))}
      </div>
    </section>
  );
}

/* ──────────────────── Sessions Screen ──────────────────── */

function SessionsScreen({ sessionsList, onOpenSessionChat, onAcceptSession, onDeclineSession, onRateSession, onCancelSession }) {
  const [filter, setFilter] = React.useState('all');
  const [feedbackSessionId, setFeedbackSessionId] = React.useState(null);

  const sessions = filter === 'all' ? sessionsList : sessionsList.filter(s => s.status === filter);
  const statusColors = { upcoming: 'status-upcoming', active: 'status-active', completed: 'status-completed', requested: 'status-requested' };

  return (
    <section className="sessions-page">
      <div className="page-header">
        <h1>Mentoring Sessions</h1>
        <p className="page-subtitle">Track your 1:1 and group peer sessions.</p>
      </div>

      <div className="sessions-tabs">
        {[{ id: 'all', label: 'All' }, { id: 'upcoming', label: 'Upcoming' }, { id: 'active', label: 'Active' }, { id: 'completed', label: 'Completed' }, { id: 'requested', label: 'Requested' }].map(tab => (
          <button key={tab.id} type="button" className={`session-tab ${filter === tab.id ? 'active' : ''}`} onClick={() => setFilter(tab.id)}>
            {tab.label}
            <span className="tab-count" style={{ marginLeft: 4 }}>({tab.id === 'all' ? sessionsList.length : sessionsList.filter(s => s.status === tab.id).length})</span>
          </button>
        ))}
      </div>

      <div className="sessions-list">
        {sessions.map(s => (
          <article key={s.id} className="session-card">
            <div className="session-card-left" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <MaskAvatar seed={s.peerAlias} size={36} />
              <div className="session-card-info">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-strong)' }}>{s.topic}</span>
                  <span className={`session-status-badge ${statusColors[s.status]}`}>{s.status}</span>
                </div>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 11 }}>with {s.peerAlias} · {s.date} ({s.duration})</p>
              </div>
            </div>
            <div className="session-card-actions">
              {s.status === 'upcoming' && <button type="button" className="primary small-btn" onClick={() => onOpenSessionChat(s)}>Join</button>}
              {s.status === 'active' && <button type="button" className="primary small-btn" onClick={() => onOpenSessionChat(s)}>Resume</button>}
              {s.status === 'requested' && <>
                <button type="button" className="primary small-btn" onClick={() => onAcceptSession(s.id)}>Accept</button>
                <button type="button" className="secondary small-btn" onClick={() => onDeclineSession(s.id)}>Decline</button>
              </>}
              {s.status === 'completed' && s.feedback && <span style={{ fontSize: 11, color: 'var(--success)' }}>{s.feedback === 'up' ? '👍 Helpful' : '👎'}</span>}
              {s.status === 'completed' && !s.feedback && <button type="button" className="secondary small-btn" onClick={() => setFeedbackSessionId(s.id)}>Rate</button>}
              {(s.status === 'upcoming' || s.status === 'requested') && <button type="button" className="quiet-button small-btn" onClick={() => onCancelSession(s.id)}>Cancel</button>}
            </div>
          </article>
        ))}
      </div>

      {feedbackSessionId && (
        <Dialog labelledBy="session-feedback-title" onCancel={() => setFeedbackSessionId(null)}>
          <div className="report-panel feedback-panel">
            <p className="eyebrow">SESSION FEEDBACK</p>
            <h2 id="session-feedback-title">Rate this session</h2>
            <p className="muted">Your feedback is completely anonymous.</p>
            <div className="feedback-choices">
              <button type="button" className="feedback-choice up" onClick={() => { onRateSession(feedbackSessionId, 'up'); setFeedbackSessionId(null); }} aria-label="Helpful"><span aria-hidden="true">👍</span> Helpful</button>
              <button type="button" className="feedback-choice down" onClick={() => { onRateSession(feedbackSessionId, 'down'); setFeedbackSessionId(null); }} aria-label="Not helpful"><span aria-hidden="true">👎</span> Not helpful</button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/* ──────────────────── Notifications Screen ──────────────────── */

function NotificationsScreen({ notifications, onNotificationClick, onMarkAllRead }) {
  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <section className="notifications-page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Notifications</h1>
          <p className="page-subtitle">{unreadCount > 0 ? `${unreadCount} unread` : 'All caught up!'}</p>
        </div>
        {unreadCount > 0 && <button type="button" className="secondary small-btn" onClick={onMarkAllRead}>Mark all read</button>}
      </div>

      <div className="notification-list">
        {notifications.map(n => (
          <button key={n.id} type="button" className={`notification-item ${!n.read ? 'unread' : ''}`} onClick={() => onNotificationClick(n)}>
            <span style={{ fontSize: 18, marginRight: 4 }} aria-hidden="true">{n.icon}</span>
            <div style={{ flex: 1 }}>
              <p className="notification-title">{n.title}</p>
              <p className="notification-body">{n.message}</p>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: 10 }}>{n.time}</p>
            </div>
            {!n.read && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', flex: 'none' }} />}
          </button>
        ))}
      </div>
    </section>
  );
}

/* ──────────────────── Profile Screen ──────────────────── */

function ProfileScreen({ alias, onEditAlias, onProfileUpdate, demoMode }) {
  const [bio, setBio] = React.useState(() => window.localStorage.getItem('maskchat-profile-bio') || 'Passionate about computer science and preparing for campus placements. Happy to discuss DSA and core subjects.');
  const [profileYear, setProfileYear] = React.useState(() => window.localStorage.getItem('maskchat-profile-year') || '3');
  const [profileSubjects, setProfileSubjects] = React.useState(() => {
    try {
      const saved = window.localStorage.getItem('maskchat-profile-subjects');
      return saved ? JSON.parse(saved) : ['Data Structures', 'Web Development', 'Placement Prep'];
    } catch {
      return ['Data Structures', 'Web Development', 'Placement Prep'];
    }
  });
  const [saved, setSaved] = React.useState(false);

  function save() {
    window.localStorage.setItem('maskchat-profile-bio', bio);
    window.localStorage.setItem('maskchat-profile-year', profileYear);
    window.localStorage.setItem('maskchat-profile-subjects', JSON.stringify(profileSubjects));
    onProfileUpdate?.({ bio, year: profileYear, subjects: profileSubjects });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <section className="profile-page">
      <div className="page-header">
        <h1>Your Anonymous Profile</h1>
        <p className="page-subtitle">Your personal identity is strictly protected on MaskChat.</p>
      </div>

      <div className="profile-card-main">
        <div className="profile-identity">
          <MaskAvatar seed={alias} size={54} />
          <div>
            <h2 style={{ margin: 0, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
              {alias}
              <button type="button" className="dash-edit-alias-btn" onClick={onEditAlias}>✏️ Change Mentee Alias</button>
            </h2>
            <p className="muted" style={{ margin: '2px 0 0' }}>Anonymous Mentee identity</p>
          </div>
        </div>

        <label className="profile-field">
          Bio / Interests
          <textarea value={bio} onChange={e => setBio(e.target.value)} rows={2} maxLength={180} />
        </label>

        <div className="profile-grid-2">
          <label className="profile-field">
            Year of study
            <select value={profileYear} onChange={e => setProfileYear(e.target.value)}>
              {[1, 2, 3, 4, 5].map(y => <option key={y} value={y}>{y}{['st', 'nd', 'rd', 'th', 'th'][y - 1]} Year</option>)}
            </select>
          </label>
        </div>

        <label className="profile-field">
          Subjects
          <div className="tag-picker-compact">
            {TAGS.map(tag => (
              <button
                key={tag}
                type="button"
                className={`tag-compact ${profileSubjects.includes(tag) ? 'active' : ''}`}
                onClick={() => setProfileSubjects(profileSubjects.includes(tag) ? profileSubjects.filter(t => t !== tag) : [...profileSubjects, tag].slice(0, 5))}
              >
                {tag}
              </button>
            ))}
          </div>
        </label>
      </div>

      <div className="profile-stats-grid">
        <div><b>{demoMode ? DEMO_ACTIVITY.totalSessions : 0}</b><span className="muted">Sessions</span></div>
        <div><b>{demoMode ? DEMO_ACTIVITY.helpfulCount : 0}</b><span className="muted">Helpful</span></div>
        <div><b>{demoMode ? DEMO_ACTIVITY.topicsExplored : 0}</b><span className="muted">Topics</span></div>
        <div><b>{demoMode ? DEMO_ACTIVITY.totalMessages : 0}</b><span className="muted">Messages</span></div>
      </div>

      <button type="button" className="primary cta" onClick={save}>{saved ? '✓ Saved' : 'Save Profile'}</button>
    </section>
  );
}

/* ──────────────────── Settings Screen ──────────────────── */

function SettingsScreen({ onLogout, chatSounds, setChatSounds }) {
  const [darkMode, setDarkMode] = React.useState(() => document.documentElement.dataset.theme !== 'light');
  const [confirmLogout, setConfirmLogout] = React.useState(false);

  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    window.localStorage.setItem('maskchat-theme', next ? 'dark' : 'light');
  }

  return (
    <section className="settings-page">
      <div className="page-header">
        <h1>Settings</h1>
        <p className="page-subtitle">Preferences and account safety.</p>
      </div>

      <div className="profile-card-main">
        <div className="settings-row">
          <div><b>Dark Mode</b><p className="muted" style={{ margin: 0 }}>High-contrast dark background</p></div>
          <button type="button" className={`toggle-switch ${darkMode ? 'on' : ''}`} onClick={toggleTheme} role="switch" aria-checked={darkMode}>
            <span className="toggle-knob" />
          </button>
        </div>
        <div className="settings-row" style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}>
          <div><b>Chat Audio Sounds</b><p className="muted" style={{ margin: 0 }}>Play subtle tone on incoming messages</p></div>
          <button type="button" className={`toggle-switch ${chatSounds ? 'on' : ''}`} onClick={() => { setChatSounds(!chatSounds); if (!chatSounds) playChatSound(); }} role="switch" aria-checked={chatSounds}>
            <span className="toggle-knob" />
          </button>
        </div>
        <div className="settings-row" style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}>
          <div><b>Sign out</b><p className="muted" style={{ margin: 0 }}>End your anonymous session</p></div>
          <button type="button" className="secondary danger-btn small-btn" onClick={() => setConfirmLogout(true)}>Sign out</button>
        </div>
      </div>

      {confirmLogout && (
        <Dialog labelledBy="logout-title" onCancel={() => setConfirmLogout(false)}>
          <div className="report-panel">
            <h2 id="logout-title">Sign out?</h2>
            <p className="muted">You will be returned to the welcome login screen.</p>
            <div className="report-actions">
              <button type="button" className="secondary" onClick={() => setConfirmLogout(false)}>Cancel</button>
              <button type="button" className="primary report-submit" onClick={() => { setConfirmLogout(false); onLogout(); }}>Sign out →</button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/* ──────────────────── Report & Feedback Panels ──────────────────── */

function ReportPanel({ onCancel, onSubmit, peers = [] }) {
  const [reason, setReason] = React.useState(REPORT_REASONS[0].value);
  const [details, setDetails] = React.useState('');
  return (
    <Dialog labelledBy="report-panel-title" onCancel={onCancel}>
      <form className="report-panel" onSubmit={(e) => { e.preventDefault(); onSubmit({ reason, details }); }}>
        <p className="eyebrow">REPORT THIS SESSION</p>
        <h2 id="report-panel-title">Report Session</h2>
        <p className="muted">Your report is reviewed by moderators anonymously.</p>
        <fieldset className="report-reasons">
          {REPORT_REASONS.map((option) => (
            <label key={option.value} className={`report-reason ${reason === option.value ? 'active' : ''}`}>
              <input type="radio" name="report-reason" value={option.value} checked={reason === option.value} onChange={() => setReason(option.value)} />
              {option.label}
            </label>
          ))}
        </fieldset>
        <label htmlFor="report-details">Details (optional)</label>
        <textarea id="report-details" rows="2" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Help moderators understand what happened" />
        <div className="report-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary report-submit">Submit Report →</button>
        </div>
      </form>
    </Dialog>
  );
}

function FeedbackPanel({ onCancel, onSubmit }) {
  return (
    <Dialog labelledBy="feedback-panel-title" onCancel={onCancel}>
      <div className="report-panel feedback-panel">
        <p className="eyebrow">SESSION FEEDBACK</p>
        <h2 id="feedback-panel-title">How was this conversation?</h2>
        <p className="muted">Your rating helps support student peers.</p>
        <div className="feedback-choices">
          <button type="button" className="feedback-choice up" onClick={() => onSubmit('up')}><span aria-hidden="true">👍</span> Helpful</button>
          <button type="button" className="feedback-choice down" onClick={() => onSubmit('down')}><span aria-hidden="true">👎</span> Not helpful</button>
        </div>
        <div className="report-actions">
          <button type="button" className="quiet-button" onClick={() => onSubmit(null)} style={{ margin: 'auto' }}>Skip</button>
        </div>
      </div>
    </Dialog>
  );
}

/* ──────────────────── Main Application Shell ──────────────────── */

function App() {
  const [email, setEmail] = React.useState('');
  const [authMode, setAuthMode] = React.useState(null);
  const [authenticated, setAuthenticated] = React.useState(false);
  const [demoMode, setDemoMode] = React.useState(false);
  const [alias, setAlias] = React.useState(() => window.localStorage.getItem('maskchat-mentee-alias') || getRandomIndianAlias());
  const [aliasModalOpen, setAliasModalOpen] = React.useState(false);
  const [screen, setScreen] = React.useState('welcome');
  const [role, setRole] = React.useState('learner');
  const [tags, setTags] = React.useState(['Data Structures']);
  const [room, setRoom] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [draft, setDraft] = React.useState('');
  const [toast, setToast] = React.useState(null);
  const [isAvailable, setIsAvailable] = React.useState(false);
  const [isMatching, setIsMatching] = React.useState(false);
  const [matchError, setMatchError] = React.useState(null);
  const [reportOpen, setReportOpen] = React.useState(false);
  const [peers, setPeers] = React.useState([]);
  const [takeaways, setTakeaways] = React.useState('');
  const [typing, setTyping] = React.useState(false);
  const [sessionSeconds, setSessionSeconds] = React.useState(0);
  const [chatSounds, setChatSounds] = React.useState(true);
  const [feedbackOpen, setFeedbackOpen] = React.useState(false);
  const [sessionSummary, setSessionSummary] = React.useState(null);
  const [connection, setConnection] = React.useState(socket.connected ? 'connected' : 'reconnecting');
  const [blockedInfo, setBlockedInfo] = React.useState(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [requestModalMentor, setRequestModalMentor] = React.useState(null);

  const [sessionsList, setSessionsList] = React.useState([]);
  const [notifications, setNotifications] = React.useState([]);
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false);
  const messagesEndRef = React.useRef(null);

  const unreadNotifCount = notifications.filter(n => !n.read).length;
  const QUICK_EMOJIS = ['😊', '👍', '❤️', '😂', '🙏', '🎉', '💡', '🔥', '✅', '👀', '💪', '🤔'];

  const notify = React.useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  function handleSaveAlias(newAlias) {
    setAlias(newAlias);
    window.localStorage.setItem('maskchat-mentee-alias', newAlias);
    setAliasModalOpen(false);
    notify(`Alias updated to ${newAlias}!`, 'info');
  }

  // Real-time session/event bridge. Demo mode uses the same socket contract
  // but is explicitly marked by the backend, so fake data never masquerades
  // as a real mentor or session.
  React.useEffect(() => {
    const incoming = (message) => {
      setMessages((current) => [...current, { ...message, mine: false, timestamp: message.sentAt ? new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined }]);
      setTyping(false);
      if (chatSounds) playChatSound();
    };
    const matched = (payload) => {
      setIsMatching(false);
      const nextRoom = {
        roomId: payload.roomId, peer: payload.peer, peers: payload.peers || [payload.peer],
        tags: payload.tags || tags, startedAt: payload.startedAt || Date.now(), demo: Boolean(payload.demo),
        mentorCard: payload.mentorCard || null, isGroup: Boolean(payload.isGroup), capacity: payload.capacity || 1
      };
      setDemoMode(Boolean(payload.demo));
      setRoom(nextRoom);
      setPeers(payload.peers || [payload.peer]);
      setMessages([{ id: `welcome-${Date.now()}`, system: true, text: `You are connected anonymously with ${payload.peer}.` }]);
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ roomId: payload.roomId }));
      setScreen('chat');
      notify(payload.demo ? 'Guided demo started!' : `Matched with ${payload.peer}.`, 'info');
    };
    const queue = (payload) => {
      if (payload?.status === 'available') { setIsMatching(false); notify('You are available for mentoring.', 'info'); }
      if (payload?.status === 'offline') { setIsAvailable(false); }
    };
    const blocked = (payload) => { setTyping(false); setBlockedInfo({ reason: payload?.reason || 'This message was blocked by the privacy filter.' }); };
    const ended = () => {
      setTyping(false);
      setIsMatching(false);
      window.sessionStorage.removeItem(SESSION_KEY);
      setRoom(null);
      setDemoMode(false);
      setScreen('summary');
    };
    const summary = (payload) => setSessionSummary(payload);
    const peerJoined = (payload) => setPeers((current) => current.includes(payload.alias) ? current : [...current, payload.alias]);
    const peerLeft = (payload) => setPeers((current) => current.filter((peer) => peer !== payload.alias));
    const connect = () => {
      setConnection('connected');
      if (!authenticated) return;
      socket.emit('identity:verify', {}, (authAck) => {
        if (!authAck?.ok) { setAuthenticated(false); socket.disconnect(); notify(authAck?.error || 'Your authentication session has expired.', 'error'); return; }
        setAlias(authAck.alias || alias);
        socket.emit('session:scheduled:list', {}, (scheduledAck) => {
          if (scheduledAck?.ok) setSessionsList(scheduledAck.sessions || []);
        });
        const saved = readSavedSession();
        if (saved?.roomId) {
          socket.emit('session:rejoin', { roomId: saved.roomId }, (ack) => {
            if (!ack?.ok) { window.sessionStorage.removeItem(SESSION_KEY); return; }
            setDemoMode(Boolean(ack.demo));
            setRoom({ roomId: ack.roomId, peer: ack.peer, peers: ack.peers || [ack.peer], tags: ack.tags || [], startedAt: ack.startedAt || Date.now(), demo: Boolean(ack.demo), mentorCard: ack.mentorCard || null, isGroup: Boolean(ack.isGroup), capacity: ack.capacity || 1 });
            setPeers(ack.peers || [ack.peer]);
            setScreen('chat');
          });
        }
      });
    };
    const disconnect = () => setConnection('lost');
    socket.on('message:received', incoming);
    socket.on('match:found', matched);
    socket.on('mentor:queue', queue);
    socket.on('message:blocked', blocked);
    socket.on('session:ended', ended);
    socket.on('session:summary', summary);
    socket.on('peer:joined', peerJoined);
    socket.on('peer:left', peerLeft);
    socket.on('connect', connect);
    socket.on('disconnect', disconnect);
    return () => {
      socket.off('message:received', incoming); socket.off('match:found', matched); socket.off('mentor:queue', queue);
      socket.off('message:blocked', blocked); socket.off('session:ended', ended); socket.off('session:summary', summary);
      socket.off('peer:joined', peerJoined); socket.off('peer:left', peerLeft); socket.off('connect', connect); socket.off('disconnect', disconnect);
    };
  }, [chatSounds, authenticated, tags]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [modeRes, sessionRes] = await Promise.all([
          fetch(`${SERVER_URL}/api/auth/mode`, { credentials: 'include' }),
          fetch(`${SERVER_URL}/api/auth/session`, { credentials: 'include' })
        ]);
        const mode = await modeRes.json();
        if (!cancelled) setAuthMode(mode);
        if (sessionRes.ok) {
          const session = await sessionRes.json();
          if (!cancelled && session.authenticated) {
            setAuthenticated(true); setAlias(session.alias); setScreen('dashboard'); socket.connect();
          }
        }
      } catch { /* server may be starting; welcome screen remains usable */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Session timer
  React.useEffect(() => {
    if (screen !== 'chat' || !room) return undefined;
    const startedAt = room?.startedAt || Date.now();
    setSessionSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const timer = window.setInterval(() => setSessionSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [screen, room]);

  React.useEffect(() => {
    const up = () => setConnection('connected');
    const down = () => setConnection('lost');
    socket.on('connect', up);
    socket.on('disconnect', down);
    return () => {
      socket.off('connect', up);
      socket.off('disconnect', down);
    };
  }, []);

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, typing, screen]);

  async function verify(event) {
    if (event && event.preventDefault) event.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (authMode?.oidc) {
      window.location.href = `${SERVER_URL}/api/auth/oidc/start`;
      return;
    }
    if (!cleanEmail) { notify('Enter your supported college email.', 'error'); return; }
    try {
      const response = await fetch(`${SERVER_URL}/api/auth/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ email: cleanEmail })
      });
      const data = await response.json();
      if (!response.ok) { notify(data.error || 'Institution verification failed.', 'error'); return; }
      setEmail(cleanEmail); setAlias(data.alias || getRandomIndianAlias());
      socket.connect();
      socket.once('connect', () => socket.emit('identity:verify', { email: cleanEmail }, (ack) => {
        if (!ack?.ok) { notify(ack?.error || 'Verification failed.', 'error'); socket.disconnect(); return; }
        setAuthenticated(true); setAlias(ack.alias || data.alias); setScreen('dashboard');
        notify(`Welcome to MaskChat, ${ack.alias || data.alias}!`, 'info');
      }));
    } catch { notify('Could not reach the MaskChat server. Please try again.', 'error'); }
  }

  function setMentorAvailability() {
    if (!authenticated || !socket.connected) { notify('Please sign in first.', 'error'); return; }
    const next = !isAvailable;
    if (next) {
      socket.emit('mentor:training:accept', {}, (ack) => {
        if (!ack?.ok) return notify(ack?.error || 'Could not enable mentoring.', 'error');
        socket.emit('mentor:available', { tags, capacity: 1, year: 3, expertise: 'intermediate', topicType: 'academic', schedule: [] }, (result) => {
          if (!result?.ok) return notify(result?.error || 'Could not become available.', 'error');
          setIsAvailable(true); notify('You are available for mentoring.', 'info');
        });
      });
    } else {
      socket.emit('mentor:unavailable'); setIsAvailable(false); notify('You are offline.', 'info');
    }
  }

  function requestMatch(demo = false) {
    if (!authenticated || !socket.connected) { notify('Please sign in first.', 'error'); return; }
    setIsMatching(true); setMatchError(null);
    if (demo) {
      socket.emit('demo:start', { tags }, (ack) => {
        if (!ack?.ok) { setIsMatching(false); notify(ack?.error || 'Could not start the demo.', 'error'); }
      });
      return;
    }
    socket.emit('match:request', { tags, topicType: 'academic', year: null, expertise: null }, (ack) => {
      if (!ack?.ok) { setIsMatching(false); setMatchError(ack?.error || 'Could not find a mentor.'); notify(ack?.error || 'Could not find a mentor.', 'error'); return; }
      if (ack.waiting) notify(`You are #${ack.position} in the mentor queue.`, 'info');
    });
  }

  function startChatWithMentor(mentor, isDemo = false) {
    const newRoom = {
      roomId: `room-${Date.now()}`,
      peer: mentor.alias,
      tags: mentor.subjects || tags,
      startedAt: Date.now(),
      demo: isDemo,
      mentorCard: mentor
    };
    setRoom(newRoom);
    setPeers([mentor.alias]);
    setMessages([
      { id: `welcome-${Date.now()}`, system: true, text: `You are connected anonymously with ${mentor.alias}.` },
      { id: `msg-1`, text: isDemo ? GUIDED_DEMO_TURNS[0] : `Hey ${alias}! I saw you were looking at ${mentor.subjects?.[0] || 'this topic'}. How can I help?`, mine: false, sender: mentor.alias, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    ]);
    setScreen('chat');
    if (chatSounds) playChatSound();
  }

  function openConversation(convo) {
    const matchingMentor = DEMO_MENTORS.find(m => m.alias === convo.peerAlias) || { alias: convo.peerAlias, subjects: [convo.topic], expertise: 'intermediate' };
    const newRoom = {
      roomId: `room-${convo.id || Date.now()}`,
      peer: convo.peerAlias,
      tags: [convo.topic],
      startedAt: Date.now() - 300000,
      mentorCard: matchingMentor
    };
    setRoom(newRoom);
    setPeers([convo.peerAlias]);
    setMessages([
      ...DEMO_CHAT_MESSAGES.map(m => ({ ...m, sender: m.mine ? alias : convo.peerAlias })),
      { id: `last-${Date.now()}`, text: convo.lastMessage, mine: false, sender: convo.peerAlias, timestamp: convo.timestamp }
    ]);
    setScreen('chat');
  }

  function openSessionChat(session) {
    const matchingMentor = DEMO_MENTORS.find(m => m.alias === session.peerAlias) || { alias: session.peerAlias, subjects: [session.topic], expertise: 'advanced' };
    const newRoom = {
      roomId: `session-${session.id}`,
      peer: session.peerAlias,
      tags: [session.topic],
      startedAt: Date.now() - 120000,
      mentorCard: matchingMentor
    };
    setRoom(newRoom);
    setPeers([session.peerAlias]);
    setMessages([
      { id: `sys-sess`, system: true, text: `Session on ${session.topic} with ${session.peerAlias} is active.` },
      { id: `m1`, text: `Hi ${alias}! Ready for our ${session.duration} session on ${session.topic}. What would you like to start with?`, mine: false, sender: session.peerAlias, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    ]);
    setScreen('chat');
  }

  function handleRequestSessionSubmit(data) {
    if (demoMode) {
      const newSession = { id: `demo-sess-${Date.now()}`, topic: data.topic, peerAlias: data.peerAlias, date: 'Demo session', duration: '30 min', status: 'upcoming', participants: 2, feedback: null, demo: true };
      setSessionsList(current => [newSession, ...current]);
      setRequestModalMentor(null);
      notify(`Demo session prepared with ${data.peerAlias}.`, 'info');
      return;
    }
    if (!socket.connected || !data.mentorRef || !data.start || !data.end) {
      notify('That mentor does not have a valid bookable time right now.', 'error');
      return;
    }
    socket.emit('session:book', { mentorRef: data.mentorRef, start: data.start, end: data.end, tags: [data.topic] }, (ack) => {
      if (!ack?.ok) { notify(ack?.error || 'Could not book this session.', 'error'); return; }
      const booked = ack.session || {};
      setSessionsList(current => [{ ...booked, peerAlias: data.peerAlias, topic: data.topic, date: booked.date || 'Upcoming', duration: `${data.start}–${data.end}`, status: 'upcoming', feedback: null }, ...current]);
      setRequestModalMentor(null);
      notify(`Session booked with ${data.peerAlias}.`, 'info');
    });
  }

  function handleAcceptSession(id) {
    setSessionsList(current => current.map(s => s.id === id ? { ...s, status: 'upcoming' } : s));
    notify('Session accepted! Moved to Upcoming.', 'info');
  }

  function handleDeclineSession(id) {
    setSessionsList(current => current.filter(s => s.id !== id));
    notify('Session declined.', 'info');
  }

  function handleRateSession(id, feedback) {
    setSessionsList(current => current.map(s => s.id === id ? { ...s, feedback } : s));
    notify(feedback === 'up' ? 'Rated as helpful 👍. Thank you!' : 'Feedback submitted.', 'info');
  }

  function handleCancelSession(id) {
    setSessionsList(current => current.filter(s => s.id !== id));
    notify('Session cancelled.', 'info');
  }

  function handleNotificationClick(notif) {
    setNotifications(current => current.map(n => n.id === notif.id ? { ...n, read: true } : n));
    if (demoMode && (notif.type === 'new_message' || notif.type === 'chat_request')) {
      startChatWithMentor(DEMO_MENTORS[0], true);
    } else {
      setScreen('sessions');
    }
  }

  function handleMarkAllRead() {
    setNotifications(current => current.map(n => ({ ...n, read: true })));
    notify('All notifications marked as read.');
  }

  function sendMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !room) return;

    const phonePattern = /\b\d{10}\b|\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/;
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
    if (phonePattern.test(text) || emailPattern.test(text)) {
      setBlockedInfo({ reason: 'Personal contact details (phone numbers or emails) are blocked by the privacy filter.' });
      return;
    }

    setDraft('');
    setBlockedInfo(null);
    setTyping(true);
    socket.emit('message:send', { roomId: room.roomId, text }, (ack) => {
      setTyping(false);
      if (!ack?.ok) { setBlockedInfo({ reason: ack?.error || 'Message could not be sent.' }); return; }
      const message = ack.message;
      setMessages(current => [...current, { ...message, mine: true, timestamp: new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
      if (chatSounds) playChatSound();
    });
  }

  function endSession(feedback = null) {
    if (!room) return;
    socket.emit('session:end', { roomId: room.roomId, feedback }, (ack) => {
      if (!ack?.ok) notify(ack?.error || 'Could not end the session.', 'error');
    });
    setFeedbackOpen(false);
  }

  function submitReport({ reason = 'other', details = '' } = {}) {
    if (!room) return;
    socket.emit('session:report', { roomId: room.roomId, reason, details: String(details || '').trim() || 'Reported from the active session.', includeMessages: false }, (ack) => {
      if (!ack?.ok) return notify(ack?.error || 'Could not submit the report.', 'error');
      setReportOpen(false); notify('Report submitted. The session will be closed safely.', 'info');
    });
  }

  function handleLogout() {
    clearSavedSession();
    socket.disconnect();
    setAuthenticated(false); setEmail(''); setRoom(null); setMessages([]); setIsAvailable(false);
    setScreen('welcome');
    notify('Signed out successfully.');
  }

  function navigate(target) {
    if (['dashboard', 'discover', 'sessions', 'notifications', 'profile', 'settings'].includes(target)) {
      setScreen(target);
    }
  }

  const live = <Toast {...(toast || {})} />;
  const aliasChip = alias ? (
    <div className="alias-chip" onClick={() => setAliasModalOpen(true)} title="Click to change alias">
      <span className="alias-avatar" aria-hidden="true">{alias.slice(0, 2)}</span>
      <span>{alias}</span>
    </div>
  ) : null;

  /* ──────── Welcome Screen with Indian Mentee Alias Selector ──────── */
  if (screen === 'welcome') return <>
    <SkipLink label="Skip to main content" />
    <main id="main-content" className="landing">
      <nav aria-label="Primary"><Brand /><div className="nav-actions"><ThemeToggle /></div></nav>
      <section className="hero hero-centered">
        <h1>Anonymous peer support<br /><em>for students, by students.</em></h1>
        <p className="lede">Ask questions. Share knowledge. Stay completely anonymous.</p>
        <form className="entry-card" onSubmit={verify}>
          <div className="card-top"><span aria-hidden="true">🎓</span><span>Enter Campus Network</span></div>
          
          <label htmlFor="email">College email</label>
          <input id="email" type="text" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@your-college.edu" />
          
          <div className="privacy-note" style={{ marginTop: 12 }}>Your anonymous alias is assigned securely after institution verification.</div>

          {authMode?.oidc ? (
            <button className="primary cta" type="button" onClick={verify} style={{ marginTop: 16 }}>🔐 Sign in with your institution →</button>
          ) : (
            <button className="primary cta" type="button" onClick={verify} style={{ marginTop: 16 }}>Continue with college email →</button>
          )}
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 11, textAlign: 'center' }}>Your real name and email are never visible to mentors or peers. Demo mode is available after entering the app.</p>
        </form>
        <ul className="trust-list"><li>No public profiles</li><li>No real names in chats</li><li>Sessions disappear on exit</li></ul>
      </section>
    </main>
    {live}
  </>;

  /* ──────── Summary Screen ──────── */
  if (screen === 'summary') return <>
    <SkipLink label="Skip to main content" />
    <main id="main-content" className="app-shell">
      <header className="app-header"><Brand /><div className="header-actions"><ThemeToggle /></div></header>
      <section style={{ maxWidth: 480, margin: '40px auto', padding: 20, textAlign: 'center' }}>
        <p className="eyebrow">SESSION COMPLETE</p>
        <div style={{ width: 50, height: 50, borderRadius: '50%', border: '2px solid var(--success)', color: 'var(--success)', fontSize: 24, display: 'grid', placeItems: 'center', margin: '14px auto' }}>✓</div>
        <h2>{sessionSummary?.topic || 'General support'}</h2>
        <p className="muted">{formatTimer(sessionSummary?.durationSeconds ?? 0)} · Messages have been securely cleared.</p>
        <textarea style={{ margin: '16px 0', width: '100%' }} value={takeaways} onChange={e => setTakeaways(e.target.value)} placeholder="Private takeaways notes (stored on your screen only)..." rows="4" />
        <button className="primary cta" onClick={() => { setSessionSummary(null); setTakeaways(''); setScreen('dashboard'); }}>Done →</button>
      </section>
    </main>
    {live}
  </>;

  /* ──────── Chat Screen ──────── */
  if (screen === 'chat') {
    return <>
    <SkipLink label="Skip to main content" />
    <main id="main-content" className="app-shell chat-shell">
      <header className="app-header">
        <Brand />
        <div className="header-actions">
          <div className="session-status" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ConnectionBadge state={connection} />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{formatTimer(sessionSeconds)}</span>
          </div>
          <button className="quiet-button" onClick={() => setReportOpen(true)}>Report</button>
          <button className="quiet-button end" onClick={() => setFeedbackOpen(true)}>End session</button>
          <ThemeToggle />
        </div>
      </header>
      <section className="chat-layout">
        <aside className="chat-side">
          <p className="eyebrow">SESSION INFO</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
            <MaskAvatar seed={room?.peer} size={42} />
            <div>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: 'var(--text-strong)' }}>{room?.peer}</p>
              <p className="muted" style={{ margin: 0, fontSize: 11 }}>Anonymous Peer</p>
            </div>
          </div>
          <ul className="session-tags">{room?.tags?.map(t => <li key={t}>{t}</li>)}</ul>
          <div style={{ marginTop: 14 }}><PrivacyGuard compact /></div>
        </aside>
        <section className="chat-panel">
          <div className="messages" role="log" aria-live="polite">
            {messages.map((message) => {
              if (message.system) return <p className="system-message" key={message.id} style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', margin: '8px 0' }}>{message.text}</p>;
              return (
                <article className={`message ${message.mine ? 'mine' : ''}`} key={message.id}>
                  <span className="message-alias">{message.sender}</span>
                  <p>{message.text}</p>
                  <div className="message-meta">
                    <span className="message-time">{message.timestamp}</span>
                    {message.mine && <span className="message-status">✓</span>}
                  </div>
                </article>
              );
            })}
            {typing && <div className="typing"><span className="typing-dots"><i /><i /><i /></span>{typing} is typing…</div>}
            <div ref={messagesEndRef} />
          </div>
          {blockedInfo && <div className="blocked-card" style={{ padding: '8px 12px', background: 'rgba(216,109,109,.15)', border: '1px solid var(--danger)', borderRadius: 8, margin: '0 16px 8px', fontSize: 12 }}>🔒 {blockedInfo.reason}</div>}
          <form className="composer" onSubmit={sendMessage}>
            <div className="composer-tools">
              <button type="button" className="composer-tool-btn" onClick={() => notify('Attachments are disabled for personal safety.')}>📎</button>
              <div className="emoji-picker-wrap">
                <button type="button" className="composer-tool-btn" onClick={() => setShowEmojiPicker(!showEmojiPicker)}>😊</button>
                {showEmojiPicker && (
                  <div className="emoji-grid">
                    {QUICK_EMOJIS.map(e => (
                      <button key={e} type="button" className="emoji-btn" onClick={() => { setDraft(d => d + e); setShowEmojiPicker(false); }}>{e}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }} placeholder="Write an anonymous message…" rows="1" />
            <button className="send" type="submit" disabled={!draft.trim()}>↑</button>
          </form>
        </section>
      </section>
      {reportOpen && <ReportPanel onCancel={() => setReportOpen(false)} onSubmit={submitReport} peers={peers} />}
      {feedbackOpen && <FeedbackPanel onCancel={() => setFeedbackOpen(false)} onSubmit={endSession} />}
    </main>
    {live}
  </>;
  }

  /* ──────── App Shell with Navigation ──────── */
  return <>
    <SkipLink label="Skip to main content" />
    <div className="app-layout">
      <Sidebar screen={screen} onNavigate={navigate} alias={alias} unreadCount={unreadNotifCount} onEditAlias={() => setAliasModalOpen(true)} />
      <main id="main-content" className="app-main">
        <header className="app-topbar">
          <div className="topbar-left">
            <button type="button" className="topbar-search-btn" onClick={() => setSearchOpen(true)}>
              <span aria-hidden="true">⌕</span>
              <span className="topbar-search-text">Search mentors, subjects…</span>
            </button>
          </div>
          <div className="topbar-right">
            {aliasChip}
          </div>
        </header>
        <div className="app-content">
          {screen === 'dashboard' && <DashboardScreen
            alias={alias} onEditAlias={() => setAliasModalOpen(true)} role={role} setRole={setRole} tags={tags} setTags={setTags}
            onNavigate={navigate} onFindMentor={() => requestMatch(false)} onTryDemo={() => requestMatch(true)}
            onStartChatWithMentor={startChatWithMentor} onOpenConversation={openConversation} onOpenSessionChat={openSessionChat}
            isMatching={isMatching} matchError={matchError} setMatchError={setMatchError} requestMatch={requestMatch}
            isAvailable={isAvailable} setMentorAvailability={setMentorAvailability}
            sessionsList={sessionsList} demoMode={demoMode}
          />}
          {screen === 'discover' && <DiscoverScreen
            onStartChat={startChatWithMentor}
            onRequestSession={(mentor) => setRequestModalMentor(mentor)} demoMode={demoMode}
          />}
          {screen === 'sessions' && <SessionsScreen
            sessionsList={sessionsList}
            onOpenSessionChat={openSessionChat}
            onAcceptSession={handleAcceptSession}
            onDeclineSession={handleDeclineSession}
            onRateSession={handleRateSession}
            onCancelSession={handleCancelSession}
          />}
          {screen === 'notifications' && <NotificationsScreen
            notifications={notifications}
            onNotificationClick={handleNotificationClick}
            onMarkAllRead={handleMarkAllRead}
          />}
          {screen === 'profile' && <ProfileScreen alias={alias} onEditAlias={() => setAliasModalOpen(true)} onProfileUpdate={() => notify('Profile updated.')} demoMode={demoMode} />}
          {screen === 'settings' && <SettingsScreen onLogout={handleLogout} chatSounds={chatSounds} setChatSounds={setChatSounds} />}
        </div>
      </main>
      <MobileNav screen={screen} onNavigate={navigate} unreadCount={unreadNotifCount} />
    </div>

    {/* Modals */}
    {searchOpen && (
      <SearchPanel
        onNavigate={navigate}
        onStartChat={startChatWithMentor}
        onOpenConversation={openConversation}
        onClose={() => setSearchOpen(false)} demoMode={demoMode}
      />
    )}

    {aliasModalOpen && (
      <ChangeAliasModal
        currentAlias={alias}
        onCancel={() => setAliasModalOpen(false)}
        onSave={handleSaveAlias}
      />
    )}

    {requestModalMentor && (
      <RequestSessionModal
        mentor={requestModalMentor}
        demoMode={demoMode}
        onCancel={() => setRequestModalMentor(null)}
        onSubmit={handleRequestSessionSubmit}
      />
    )}

    {live}
  </>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
