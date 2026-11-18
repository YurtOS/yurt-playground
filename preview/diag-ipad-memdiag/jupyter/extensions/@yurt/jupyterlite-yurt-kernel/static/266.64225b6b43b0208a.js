"use strict";(self.rspackChunk_yurt_jupyterlite_yurt_kernel=self.rspackChunk_yurt_jupyterlite_yurt_kernel||[]).push([[266],{646(e,t,r){var n=r(601),o=r.n(n),a=r(314),s=(r.n(a))()(o());s.push([e.id,`/* The ipykernel-backed Yurt kernel has no UI of its own; the snapshot one has a panel. */

/* The suspend/resume panel of the yurt-snapshot kernel. */
.yurt-snapshot-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 1000;
  min-width: 220px;
  max-width: 360px;
  padding: 10px 12px;
  border: 1px solid var(--jp-border-color1, #c0c0c0);
  border-radius: 6px;
  background: var(--jp-layout-color1, #fff);
  color: var(--jp-ui-font-color1, #222);
  font-family: var(--jp-ui-font-family, sans-serif);
  font-size: var(--jp-ui-font-size1, 13px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.yurt-snapshot-title {
  font-weight: 600;
  margin-bottom: 2px;
}
.yurt-snapshot-state {
  margin-bottom: 6px;
}
.yurt-snapshot-panel[data-state="suspended"] .yurt-snapshot-state {
  color: var(--jp-warn-color1, #b36b00);
}
.yurt-snapshot-buttons button {
  margin-right: 6px;
  padding: 3px 10px;
}
.yurt-snapshot-status {
  margin-top: 6px;
  color: var(--jp-ui-font-color2, #666);
  font-size: var(--jp-ui-font-size0, 11px);
  white-space: pre-wrap;
}

/* An HTML output's sandboxed frame (src/output_frame.ts). The page cannot
 * measure its content, so the frame scrolls and the wrapper has a resize
 * handle: its first height is a guess, set inline, between these bounds. */
.yurt-OutputFrame {
  box-sizing: border-box;
  resize: vertical;
  overflow: hidden;
  min-height: 44px;
  max-height: 90vh;
  /* The resize grip's strip: WebKit gives a grip under the frame to the
   * frame, so the frame must not cover it. */
  padding-bottom: 12px;
}
.yurt-OutputFrame iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
`,""]),r.d(t,{},{A:s})},314(e){e.exports=function(e){var t=[];return t.toString=function(){return this.map(function(t){var r="",n=void 0!==t[5];return t[4]&&(r+="@supports (".concat(t[4],") {")),t[2]&&(r+="@media ".concat(t[2]," {")),n&&(r+="@layer".concat(t[5].length>0?" ".concat(t[5]):""," {")),r+=e(t),n&&(r+="}"),t[2]&&(r+="}"),t[4]&&(r+="}"),r}).join("")},t.i=function(e,r,n,o,a){"string"==typeof e&&(e=[[null,e,void 0]]);var s={};if(n)for(var i=0;i<this.length;i++){var p=this[i][0];null!=p&&(s[p]=!0)}for(var u=0;u<e.length;u++){var c=[].concat(e[u]);n&&s[c[0]]||(void 0!==a&&(void 0===c[5]||(c[1]="@layer".concat(c[5].length>0?" ".concat(c[5]):""," {").concat(c[1],"}")),c[5]=a),r&&(c[2]&&(c[1]="@media ".concat(c[2]," {").concat(c[1],"}")),c[2]=r),o&&(c[4]?(c[1]="@supports (".concat(c[4],") {").concat(c[1],"}"),c[4]=o):c[4]="".concat(o)),t.push(c))}},t}},601(e){e.exports=function(e){return e[1]}},665(e,t,r){r.r(t);var n=r(72),o=r.n(n),a=r(825),s=r.n(a),i=r(659),p=r.n(i),u=r(56),c=r.n(u),l=r(540),d=r.n(l),f=r(113),h=r.n(f),m=r(646),v={};v.styleTagTransform=h(),v.setAttributes=c(),v.insert=p().bind(null,"head"),v.domAPI=s(),v.insertStyleElement=d(),o()(m.A,v);let y=m.A&&m.A.locals?m.A.locals:void 0;r.d(t,{},{default:y})},72(e){var t=[];function r(e){for(var r=-1,n=0;n<t.length;n++)if(t[n].identifier===e){r=n;break}return r}function n(e,n){for(var o={},a=[],s=0;s<e.length;s++){var i=e[s],p=n.base?i[0]+n.base:i[0],u=o[p]||0,c="".concat(p," ").concat(u);o[p]=u+1;var l=r(c),d={css:i[1],media:i[2],sourceMap:i[3],supports:i[4],layer:i[5]};if(-1!==l)t[l].references++,t[l].updater(d);else{var f=function(e,t){var r=t.domAPI(t);return r.update(e),function(t){t?(t.css!==e.css||t.media!==e.media||t.sourceMap!==e.sourceMap||t.supports!==e.supports||t.layer!==e.layer)&&r.update(e=t):r.remove()}}(d,n);n.byIndex=s,t.splice(s,0,{identifier:c,updater:f,references:1})}a.push(c)}return a}e.exports=function(e,o){var a=n(e=e||[],o=o||{});return function(e){e=e||[];for(var s=0;s<a.length;s++){var i=r(a[s]);t[i].references--}for(var p=n(e,o),u=0;u<a.length;u++){var c=r(a[u]);0===t[c].references&&(t[c].updater(),t.splice(c,1))}a=p}}},659(e){var t={};e.exports=function(e,r){var n=function(e){if(void 0===t[e]){var r=document.querySelector(e);if(window.HTMLIFrameElement&&r instanceof window.HTMLIFrameElement)try{r=r.contentDocument.head}catch(e){r=null}t[e]=r}return t[e]}(e);if(!n)throw Error("Couldn't find a style target. This probably means that the value for the 'insert' parameter is invalid.");n.appendChild(r)}},540(e){e.exports=function(e){var t=document.createElement("style");return e.setAttributes(t,e.attributes),e.insert(t,e.options),t}},56(e,t,r){e.exports=function(e){var t=r.nc;t&&e.setAttribute("nonce",t)}},825(e){e.exports=function(e){if("u"<typeof document)return{update:function(){},remove:function(){}};var t=e.insertStyleElement(e);return{update:function(r){var n,o,a;n="",r.supports&&(n+="@supports (".concat(r.supports,") {")),r.media&&(n+="@media ".concat(r.media," {")),(o=void 0!==r.layer)&&(n+="@layer".concat(r.layer.length>0?" ".concat(r.layer):""," {")),n+=r.css,o&&(n+="}"),r.media&&(n+="}"),r.supports&&(n+="}"),(a=r.sourceMap)&&"u">typeof btoa&&(n+="\n/*# sourceMappingURL=data:application/json;base64,".concat(btoa(unescape(encodeURIComponent(JSON.stringify(a))))," */")),e.styleTagTransform(n,t,e.options)},remove:function(){var e;null===(e=t).parentNode||e.parentNode.removeChild(e)}}}},113(e){e.exports=function(e,t){if(t.styleSheet)t.styleSheet.cssText=e;else{for(;t.firstChild;)t.removeChild(t.firstChild);t.appendChild(document.createTextNode(e))}}}}]);