import { createElement as h } from 'react';
import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return h(Html, { lang: 'en' }, h(Head), h('body', null, h(Main), h(NextScript)));
}
