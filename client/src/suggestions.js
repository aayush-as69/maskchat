// Starter questions for the empty chat, keyed by the same subject tags the
// dashboard offers. Fully static/local: nothing here is sent anywhere, and
// picking one only fills the composer - the person still edits and sends it.
export const SUGGESTIONS = {
  'Data Structures': [
    'Can you explain recursion?',
    'When should I use a stack vs a queue?',
    'Can you review my approach to this problem?'
  ],
  'Operating Systems': [
    'Can you explain deadlocks with an example?',
    'What is the difference between a process and a thread?',
    'How should I prepare OS for exams?'
  ],
  DBMS: [
    'Can you explain normalization?',
    'Can you help me understand SQL joins?',
    'How should I prepare DBMS for exams?'
  ],
  'Web Development': [
    'Where should I start with web development?',
    'What projects should I build to learn it?',
    'Can you explain how the frontend talks to a backend?'
  ],
  'Placement Prep': [
    'How should I start DSA?',
    'What projects should I build?',
    'How do I prepare for interviews?'
  ],
  'Computer Networks': [
    'Can you explain the OSI model simply?',
    'What actually happens when I open a website?',
    'How should I prepare Computer Networks for exams?'
  ],
  Python: [
    'What should I learn first in Python?',
    'Can you explain list comprehensions?',
    'Can you suggest a beginner Python project?'
  ],
  Java: [
    'Can you explain OOP concepts with examples?',
    'What is the difference between an interface and an abstract class?',
    'How should I practise Java for interviews?'
  ]
};

const GENERIC = [
  'Can you review my approach?',
  'How would you start learning this?',
  'What mistakes should I avoid?'
];

// Round-robins across the selected tags (first suggestion of each tag, then
// the second of each, ...) so a chat about two topics gets a mix instead of
// three questions about whichever tag was picked first. Tags with no entry
// (e.g. the demo's fallback topic) fall back to generic openers.
export function getSuggestions(tags, limit = 3) {
  const lists = (Array.isArray(tags) ? tags : []).map((tag) => SUGGESTIONS[tag]).filter(Boolean);
  const picked = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let added = false;
    for (const list of lists) {
      if (round < list.length && !picked.includes(list[round])) {
        picked.push(list[round]);
        added = true;
        if (picked.length >= limit) break;
      }
    }
    if (!added) break;
  }
  for (const generic of GENERIC) {
    if (picked.length >= limit) break;
    if (!picked.includes(generic)) picked.push(generic);
  }
  return picked.slice(0, limit);
}
