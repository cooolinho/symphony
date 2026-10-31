// TEMPORARY diagnostics: print failing tests as GitHub annotations.
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data.details?.error?.failureType !== 'subtestsFailed') {
      const err = event.data.details?.error;
      const msg = String(err?.cause?.message ?? err?.message ?? err).replace(/\r?\n/g, '%0A').slice(0, 3000);
      yield `::error title=${String(event.data.name).replace(/[\n,:]/g, ' ').slice(0, 200)}::${event.data.file ?? ''} :: ${msg}\n`;
    }
  }
}
