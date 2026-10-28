import { createElement } from 'react';
import '../public/portal.css';

export default function App({ Component, pageProps }) {
  return createElement(Component, pageProps);
}
