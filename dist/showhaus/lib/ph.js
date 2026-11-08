/* SHOWHAUS → PostHog (project "Sumzup" is the org's only project on this plan, so every event carries
   product=showhaus; filter on it). Pageviews, autocapture, funnels and session replay with all inputs masked.
   Never sends an email or name: people stay anonymous. Honours Global Privacy Control / Do Not Track. */
(() => {
  'use strict';
  const quiet = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';
  // Production only: previews, workers.dev, localhost and the CI judges never send analytics.
  if (quiet || window.posthog || !/^(www\.)?showhaus\.app$/.test(location.hostname)) return;
  const synthetic = new URLSearchParams(location.search).get('synthetic') === '1' || (() => { try { return sessionStorage.getItem('sh_synth') === '1'; } catch { return false; } })();
  // Official loader (posthog-js), unchanged.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  window.posthog.init('phc_z7qYzteR85WcVGvZjZLVAH6v7VM42Z3ik4WU8dBMfTVJ', {
    api_host: 'https://us.i.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
    session_recording: { maskAllInputs: true, maskTextSelector: '#acctDlg, [data-ph-mask]' },
    loaded: ph => ph.register({ product: 'showhaus', page_kind: location.pathname.split('/')[1] || 'home', synthetic })
  });
})();
