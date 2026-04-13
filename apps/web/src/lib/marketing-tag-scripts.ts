export function buildGoogleTagManagerScript(gtmId: string): string {
  const encodedGtmId = JSON.stringify(gtmId);
  return `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${encodedGtmId});`;
}

export function buildImpactUttScript(impactUttId: string): string {
  const encodedScriptUrl = JSON.stringify(`https://utt.impactcdn.com/${impactUttId}.js`);
  return `(function(a,b,c,d,e,f,g){e.ire_o=c;e[c]=e[c]||function(){(e[c].a=e[c].a||[]).push(arguments)};f=d.createElement(b);g=d.getElementsByTagName(b)[0];f.async=1;f.src=a;g.parentNode.insertBefore(f,g);})(${encodedScriptUrl},'script','ire',document,window);`;
}
