const SMARTBASE_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDr0UtB5smvbB4HjmqQ_RueEY6lXR1Oqx8",
  authDomain: "smartbase-auth.firebaseapp.com",
  projectId: "smartbase-auth",
  storageBucket: "smartbase-auth.firebasestorage.app",
  messagingSenderId: "438056540531",
  appId: "1:438056540531:web:6f8af95cc3539df2d6cd06"
};

const firebaseApp = firebase.initializeApp(SMARTBASE_FIREBASE_CONFIG);
const firebaseAuth = firebaseApp.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

async function finishFirebaseLogin(firebaseUser, termsAccepted = false) {
  if (!firebaseUser) throw new Error('Google authentication did not return a user.');
  const idToken = await firebaseUser.getIdToken(true);
  const res = await fetch('/api/v1/auth/firebase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, termsAccepted, termsVersion: '2026-09-29' })
  });
  const data = await res.json().catch(() => ({ message: 'Invalid authentication response.' }));
  if (!res.ok) throw new Error(data.message || data.error || 'Google authentication failed.');
  return data;
}

async function startGoogleAuth() {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 700;
  if (mobile) {
    sessionStorage.setItem('smartbase_google_pending', '1');
    await firebaseAuth.signInWithRedirect(googleProvider);
    return null;
  }
  try {
    const result = await firebaseAuth.signInWithPopup(googleProvider);
    return finishFirebaseLogin(result.user, sessionStorage.getItem('smartbase_terms_pending') === '1');
  } catch (error) {
    if (error?.code === 'auth/popup-blocked') {
      sessionStorage.setItem('smartbase_google_pending', '1');
      await firebaseAuth.signInWithRedirect(googleProvider);
      return null;
    }
    throw error;
  }
}

async function handleFirebaseRedirectResult() {
  if (!sessionStorage.getItem('smartbase_google_pending')) return null;
  sessionStorage.removeItem('smartbase_google_pending');
  console.log('[Smartbase Firebase] Checking redirect result...');
  let result;
  try {
    result = await firebaseAuth.getRedirectResult();
    console.log('[Smartbase Firebase] Redirect result:', result);
  } catch (error) {
    console.error('[Smartbase Firebase] Redirect result error:', error);
    throw error;
  }
  if (!result || !result.user) return null;
  const termsAccepted = sessionStorage.getItem('smartbase_terms_pending') === '1';
  sessionStorage.removeItem('smartbase_terms_pending');
  return finishFirebaseLogin(result.user, termsAccepted);
}

window.smartbaseFirebase = { startGoogleAuth, handleFirebaseRedirectResult, firebaseAuth };
