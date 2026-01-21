(function(){
  const p=(location.pathname.split('/').pop()||'index.html').toLowerCase();
  document.querySelectorAll('.nav-links a').forEach(a=>{
    const h=(a.getAttribute('href')||'').toLowerCase();
    if(h===p) a.setAttribute('aria-current','page');
  });
})();
