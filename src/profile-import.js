const PROFILE_FIELDS = ['resumeText', 'jobDescription', 'knowledgeBase', 'starStories',
  'whyCompany', 'whyLeaving', 'workStyle', 'salaryTarget', 'questionsToAsk', 'aiRules',
  'answerLength', 'includeScreen', 'autoAnswer'];

function mergeProfile(settings, profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Profile must be a JSON object.');
  const next = { ...settings };
  for (const field of PROFILE_FIELDS) {
    if (!Object.hasOwn(profile, field)) continue;
    const expected = ['includeScreen', 'autoAnswer'].includes(field) ? 'boolean' : 'string';
    if (typeof profile[field] !== expected) throw new Error(`Invalid profile field: ${field}`);
    next[field] = profile[field];
  }
  if (next.aiRules?.length > 2000) throw new Error('AI rules exceed 2000 characters.');
  if (next.answerLength && !['brief', 'balanced', 'detailed'].includes(next.answerLength)) throw new Error('Invalid answer length.');
  return next;
}

module.exports = { PROFILE_FIELDS, mergeProfile };
