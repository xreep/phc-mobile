// Stand-in for `.css` / `.module.css` imports, which Metro understands but Jest
// does not. Returns an empty object so `import classes from './x.module.css'`
// yields undefined class names instead of a syntax error.
module.exports = {};
