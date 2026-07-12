import { mount } from 'svelte';

import App from './App.svelte';
import './app.css';
import './editor.css';
import './wizard.css';

const target = document.getElementById('app');
if (!target) throw new Error('Garbanzo web app mount point is missing');

mount(App, { target });
