// apploopback.exe include|exclude <pid | hwnd:N>
// Cattura l'audio dell'albero di processi indicato (include) o di tutto tranne quello (exclude)
// e scrive PCM 48 kHz stereo s16le su stdout. Richiede Windows 10 2004+ (process loopback WASAPI).
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else // Windows SDK < 10.0.19041: dichiarazioni minime equivalenti a quelle dell'SDK recente
enum AUDIOCLIENT_ACTIVATION_TYPE { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK };
enum PROCESS_LOOPBACK_MODE { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE };
struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; };
struct AUDIOCLIENT_ACTIVATION_PARAMS { AUDIOCLIENT_ACTIVATION_TYPE ActivationType; union { AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; }; };
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif
#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#include <wrl/implements.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")
using namespace Microsoft::WRL;

struct Handler : RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
    HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HRESULT hr = E_FAIL;
    ComPtr<IAudioClient> client;
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT act = E_FAIL;
        ComPtr<IUnknown> unk;
        hr = op->GetActivateResult(&act, &unk);
        if (SUCCEEDED(hr)) hr = act;
        if (SUCCEEDED(hr)) hr = unk.As(&client);
        SetEvent(done);
        return S_OK;
    }
};

static int fail(const char* what, HRESULT hr) {
    fprintf(stderr, "%s fallito (0x%08lx)\n", what, (unsigned long)hr);
    return 1;
}

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "uso: apploopback include|exclude <pid|hwnd:N>\n"); return 2; }
    DWORD pid = 0;
    if (!strncmp(argv[2], "hwnd:", 5)) GetWindowThreadProcessId((HWND)(INT_PTR)_strtoi64(argv[2] + 5, nullptr, 10), &pid);
    else pid = strtoul(argv[2], nullptr, 10);
    if (!pid) return fail("ricerca processo", E_INVALIDARG);

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    _setmode(_fileno(stdout), _O_BINARY);

    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = strcmp(argv[1], "exclude")
        ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
        : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = (BYTE*)&params;

    auto handler = Make<Handler>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> op;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op);
    if (FAILED(hr)) return fail("ActivateAudioInterfaceAsync", hr);
    WaitForSingleObject(handler->done, INFINITE);
    if (FAILED(handler->hr)) return fail("attivazione", handler->hr);
    IAudioClient* client = handler->client.Get();

    WAVEFORMATEX fmt = { WAVE_FORMAT_PCM, 2, 48000, 48000 * 4, 4, 16, 0 };
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        200000, 0, &fmt, nullptr);
    if (FAILED(hr)) return fail("Initialize", hr);
    HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    client->SetEventHandle(ev);
    ComPtr<IAudioCaptureClient> cap;
    hr = client->GetService(IID_PPV_ARGS(&cap));
    if (FAILED(hr)) return fail("GetService", hr);
    if (FAILED(hr = client->Start())) return fail("Start", hr);

    static BYTE zeros[48000 * 4];
    for (;;) {
        WaitForSingleObject(ev, 1000);
        UINT32 n = 0;
        while (SUCCEEDED(cap->GetNextPacketSize(&n)) && n) {
            BYTE* data; UINT32 frames; DWORD flags;
            if (FAILED(hr = cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) return fail("GetBuffer", hr);
            size_t bytes = min((size_t)frames * 4, sizeof zeros);
            bool ok = fwrite(flags & AUDCLNT_BUFFERFLAGS_SILENT ? zeros : data, 1, bytes, stdout) == bytes;
            cap->ReleaseBuffer(frames);
            if (!ok) return 0; // l'app ha chiuso la pipe
        }
        if (fflush(stdout)) return 0;
    }
}
