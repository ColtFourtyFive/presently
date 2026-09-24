import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './shared/base.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
