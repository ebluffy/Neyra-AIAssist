import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import { App } from './App';
import { startupPerf } from './perf';
import './styles.css';
const firstRender = window.__NEYRA_PERF__ === true ? startupPerf(true) : undefined;
function StartupPerf() {
  React.useEffect(() => firstRender?.(), []);
  return null;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode>{firstRender && <StartupPerf />}<App /></React.StrictMode>);
