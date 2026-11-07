// The skills of the Maven page that come with the app, in its skills folder (kept in Git): what the agent looks for in a
// microservice for Local setup (local-setup.js), and how it reads the console for Analyse with agent
// (console-analysis.js). The user's copies are in data/skills: the user may change them; the form of the answer and the
// rules around it are the app's.
const fs = require('fs');
const path = require('path');

const skill = (name) => fs.readFileSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md'), 'utf8');

const LOCAL_SETUP_SKILL = skill('local-setup');
const CONSOLE_FIX_SKILL = skill('console-fix');

module.exports = { LOCAL_SETUP_SKILL, CONSOLE_FIX_SKILL };
