import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ComposerApp } from './ui/composer-app';
import { InspectionApp } from './ui/inspection-app';
import './ui/styles.css';

const inspection = window.location.pathname === '/render/inspection';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {inspection ? <InspectionApp /> : <ComposerApp />}
  </StrictMode>,
);
