// Applies the saved theme before first paint (loaded as a blocking classic script; CSP forbids inline scripts).
try {
  var t = localStorage.getItem('quet-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
