import { createFakeModule } from '../worker-fs.ts';
export default async function () {
  return createFakeModule({callMain(args, fs) {
    if (args.includes('hang')) { for (;;) {} }
    fs.writeFile('/project/main.pdf', '%PDF-1.5 runtime fixture');
    fs.writeFile('/project/main.aux', 'stable');
    fs.writeFile('/project/main.log', 'ok');
    return 0;
  }});
}
