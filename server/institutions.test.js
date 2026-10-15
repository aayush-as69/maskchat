import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInstitutions, resolveInstitutionByEmail, resolveInstitutionById, publicInstitutionList } from './institutions.js';

test('with no INSTITUTIONS env, loads the explicit default institution registry', () => {
  const institutions = loadInstitutions({});
  assert.equal(institutions.length, 5);
  assert.ok(institutions.some((institution) => institution.domain === 'galgotiacollege.edu.in'));
  assert.ok(institutions.some((institution) => institution.domain === 'galgotiasuniversity.edu.in'));
});

test('INSTITUTIONS env is parsed into a normalized list with derived ids', () => {
  const institutions = loadInstitutions({
    INSTITUTIONS: JSON.stringify([
      { name: 'Galgotias College', domain: 'galgotiacollege.edu.in' },
      { id: 'amity', name: 'Amity University', domain: 'amity.edu' }
    ])
  });
  assert.deepEqual(institutions.map((institution) => institution.id), ['galgotias-college', 'amity']);
});

test('duplicate ids or domains in INSTITUTIONS are rejected', () => {
  assert.throws(() => loadInstitutions({
    INSTITUTIONS: JSON.stringify([{ name: 'A', domain: 'x.edu' }, { name: 'A', domain: 'y.edu' }])
  }), /duplicate institution id/);
  assert.throws(() => loadInstitutions({
    INSTITUTIONS: JSON.stringify([{ name: 'A', domain: 'x.edu' }, { name: 'B', domain: 'x.edu' }])
  }), /duplicate domain/);
});

test('malformed INSTITUTIONS env is rejected with a clear error', () => {
  assert.throws(() => loadInstitutions({ INSTITUTIONS: 'not json' }), /not valid JSON/);
  assert.throws(() => loadInstitutions({ INSTITUTIONS: '[]' }), /non-empty JSON array/);
  assert.throws(() => loadInstitutions({ INSTITUTIONS: JSON.stringify([{ name: 'No domain' }]) }), /must have a non-empty/);
});

test('email resolution matches by exact domain suffix, not substring', () => {
  const institutions = loadInstitutions({});
  assert.equal(resolveInstitutionByEmail('student@galgotiacollege.edu.in', institutions)?.id, 'galgotias');
  // A domain that merely ends with the real one must not match.
  assert.equal(resolveInstitutionByEmail('student@notgalgotiacollege.edu.in', institutions), null);
  assert.equal(resolveInstitutionByEmail('student@galgotiacollege.edu.in.evil.com', institutions), null);
  assert.equal(resolveInstitutionByEmail('not-an-email', institutions), null);
  assert.equal(resolveInstitutionByEmail('', institutions), null);
});

test('matching stays isolated: two institutions resolve independently', () => {
  const institutions = loadInstitutions({
    INSTITUTIONS: JSON.stringify([
      { id: 'a', name: 'College A', domain: 'a.edu' },
      { id: 'b', name: 'College B', domain: 'b.edu' }
    ])
  });
  const fromA = resolveInstitutionByEmail('student@a.edu', institutions);
  const fromB = resolveInstitutionByEmail('student@b.edu', institutions);
  assert.equal(fromA.id, 'a');
  assert.equal(fromB.id, 'b');
  assert.notEqual(fromA.id, fromB.id);
});

test('resolveInstitutionById and publicInstitutionList', () => {
  const institutions = loadInstitutions({
    INSTITUTIONS: JSON.stringify([{ id: 'a', name: 'College A', domain: 'a.edu' }])
  });
  assert.equal(resolveInstitutionById('a', institutions)?.name, 'College A');
  assert.equal(resolveInstitutionById('missing', institutions), null);
  assert.deepEqual(publicInstitutionList(institutions), [{ id: 'a', name: 'College A', domain: 'a.edu', branding: { logoUrl: '', primary: '#0b7b9e', secondary: '#3c6e71' }, moderationContact: null }]);
});

test('institution rate limits and branding are normalized', () => {
  const [institution] = loadInstitutions({ INSTITUTIONS: JSON.stringify([{ id: 'x', name: 'X', domain: 'x.edu', rateLimitPool: 'pool-x', rateLimit: 12, branding: { logoUrl: 'https://x.edu/logo.svg', primary: '#123456', secondary: '#654321' }, moderationContact: 'mod@x.edu' }]) });
  assert.equal(institution.rateLimitPool, 'pool-x');
  assert.equal(institution.rateLimit, 12);
  assert.deepEqual(institution.branding, { logoUrl: 'https://x.edu/logo.svg', primary: '#123456', secondary: '#654321' });
  assert.equal(institution.moderationContact, 'mod@x.edu');
});
