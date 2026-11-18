"use strict";(self.rspackChunk_yurt_jupyterlite_yurt_kernel=self.rspackChunk_yurt_jupyterlite_yurt_kernel||[]).push([[266],{646(t,e,r){var n=r(601),o=r.n(n),a=r(314),s=(r.n(a))()(o());s.push([t.id,`/* The ipykernel-backed Yurt kernel has no UI of its own; the snapshot one has a panel. */

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
`,""]),r.d(e,{},{A:s})},314(t){t.exports=function(t){var e=[];return e.toString=function(){return this.map(function(e){var r="",n=void 0!==e[5];return e[4]&&(r+="@supports (".concat(e[4],") {")),e[2]&&(r+="@media ".concat(e[2]," {")),n&&(r+="@layer".concat(e[5].length>0?" ".concat(e[5]):""," {")),r+=t(e),n&&(r+="}"),e[2]&&(r+="}"),e[4]&&(r+="}"),r}).join("")},e.i=function(t,r,n,o,a){"string"==typeof t&&(t=[[null,t,void 0]]);var s={};if(n)for(var i=0;i<this.length;i++){var p=this[i][0];null!=p&&(s[p]=!0)}for(var c=0;c<t.length;c++){var u=[].concat(t[c]);n&&s[u[0]]||(void 0!==a&&(void 0===u[5]||(u[1]="@layer".concat(u[5].length>0?" ".concat(u[5]):""," {").concat(u[1],"}")),u[5]=a),r&&(u[2]&&(u[1]="@media ".concat(u[2]," {").concat(u[1],"}")),u[2]=r),o&&(u[4]?(u[1]="@supports (".concat(u[4],") {").concat(u[1],"}"),u[4]=o):u[4]="".concat(o)),e.push(u))}},e}},601(t){t.exports=function(t){return t[1]}},665(t,e,r){r.r(e);var n=r(72),o=r.n(n),a=r(825),s=r.n(a),i=r(659),p=r.n(i),c=r(56),u=r.n(c),l=r(540),d=r.n(l),f=r(113),h=r.n(f),v=r(646),m={};m.styleTagTransform=h(),m.setAttributes=u(),m.insert=p().bind(null,"head"),m.domAPI=s(),m.insertStyleElement=d(),o()(v.A,m);let y=v.A&&v.A.locals?v.A.locals:void 0;r.d(e,{},{default:y})},72(t){var e=[];function r(t){for(var r=-1,n=0;n<e.length;n++)if(e[n].identifier===t){r=n;break}return r}function n(t,n){for(var o={},a=[],s=0;s<t.length;s++){var i=t[s],p=n.base?i[0]+n.base:i[0],c=o[p]||0,u="".concat(p," ").concat(c);o[p]=c+1;var l=r(u),d={css:i[1],media:i[2],sourceMap:i[3],supports:i[4],layer:i[5]};if(-1!==l)e[l].references++,e[l].updater(d);else{var f=function(t,e){var r=e.domAPI(e);return r.update(t),function(e){e?(e.css!==t.css||e.media!==t.media||e.sourceMap!==t.sourceMap||e.supports!==t.supports||e.layer!==t.layer)&&r.update(t=e):r.remove()}}(d,n);n.byIndex=s,e.splice(s,0,{identifier:u,updater:f,references:1})}a.push(u)}return a}t.exports=function(t,o){var a=n(t=t||[],o=o||{});return function(t){t=t||[];for(var s=0;s<a.length;s++){var i=r(a[s]);e[i].references--}for(var p=n(t,o),c=0;c<a.length;c++){var u=r(a[c]);0===e[u].references&&(e[u].updater(),e.splice(u,1))}a=p}}},659(t){var e={};t.exports=function(t,r){var n=function(t){if(void 0===e[t]){var r=document.querySelector(t);if(window.HTMLIFrameElement&&r instanceof window.HTMLIFrameElement)try{r=r.contentDocument.head}catch(t){r=null}e[t]=r}return e[t]}(t);if(!n)throw Error("Couldn't find a style target. This probably means that the value for the 'insert' parameter is invalid.");n.appendChild(r)}},540(t){t.exports=function(t){var e=document.createElement("style");return t.setAttributes(e,t.attributes),t.insert(e,t.options),e}},56(t,e,r){t.exports=function(t){var e=r.nc;e&&t.setAttribute("nonce",e)}},825(t){t.exports=function(t){if("u"<typeof document)return{update:function(){},remove:function(){}};var e=t.insertStyleElement(t);return{update:function(r){var n,o,a;n="",r.supports&&(n+="@supports (".concat(r.supports,") {")),r.media&&(n+="@media ".concat(r.media," {")),(o=void 0!==r.layer)&&(n+="@layer".concat(r.layer.length>0?" ".concat(r.layer):""," {")),n+=r.css,o&&(n+="}"),r.media&&(n+="}"),r.supports&&(n+="}"),(a=r.sourceMap)&&"u">typeof btoa&&(n+="\n/*# sourceMappingURL=data:application/json;base64,".concat(btoa(unescape(encodeURIComponent(JSON.stringify(a))))," */")),t.styleTagTransform(n,e,t.options)},remove:function(){var t;null===(t=e).parentNode||t.parentNode.removeChild(t)}}}},113(t){t.exports=function(t,e){if(e.styleSheet)e.styleSheet.cssText=t;else{for(;e.firstChild;)e.removeChild(e.firstChild);e.appendChild(document.createTextNode(t))}}}}]);