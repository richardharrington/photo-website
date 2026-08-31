/**
 * `libheif-js` ships no type declarations. Only the small surface the pipeline
 * uses is declared here, matching the structural `HeifDecoder` interface in
 * src/pipeline/decode.ts.
 *
 * The ESM bundle is imported by its explicit path: the package's default entry
 * is CommonJS and fails in a browser with "module is not defined".
 */
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  export interface LibheifImage {
    get_width(): number;
    get_height(): number;
    display(
      image: { data: Uint8ClampedArray; width: number; height: number },
      callback: (result: { data: Uint8ClampedArray } | null) => void,
    ): void;
    free?(): void;
  }

  export interface LibheifModule {
    HeifDecoder: new () => {
      decode(buffer: ArrayBuffer | Uint8Array): LibheifImage[];
    };
  }

  /** Emscripten factory: resolves once the inlined WebAssembly is ready. */
  export default function createLibheif(): Promise<LibheifModule>;
}
