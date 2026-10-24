module.exports = function () {
  const worker = this.resourceQuery.includes('sharedworker') ? 'SharedWorker' : 'Worker';
  return `export default function WorkerFactory(options) { return new ${worker}(new URL(${JSON.stringify(this.resourcePath)}, import.meta.url), options); }`;
};
