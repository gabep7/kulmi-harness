@preconcurrency import Foundation

@MainActor
final class RPCClient {
    enum ClientError: LocalizedError {
        case notRunning
        case invalidResponse
        case server(String)

        var errorDescription: String? {
            switch self {
            case .notRunning: "Kulmi CLI is not running"
            case .invalidResponse: "Kulmi returned an invalid response"
            case .server(let message): message
            }
        }
    }

    var onNotification: ((String, [String: Any]) -> Void)?
    var onTermination: ((String) -> Void)?

    private var process: Process?
    private var input: FileHandle?
    private var outputBuffer = Data()
    private var nextID = 1
    private var pending: [Int: (Result<Any, Error>) -> Void] = [:]

    func start(cliPath: String, cwd: String) throws {
        stop()
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        let stdin = Pipe()

        if cliPath.isEmpty {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["kulmi", "rpc", "--cwd", cwd]
        } else if cliPath.hasSuffix(".js") || cliPath.hasSuffix(".mjs") || cliPath.hasSuffix(".cjs") {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", cliPath, "rpc", "--cwd", cwd]
        } else {
            process.executableURL = URL(fileURLWithPath: cliPath)
            process.arguments = ["rpc", "--cwd", cwd]
        }
        process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            Task { @MainActor [weak self] in
                self?.onTermination?("Kulmi CLI exited with status \(status)")
            }
        }
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor [weak self, data] in self?.receive(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self, text] in self?.onNotification?("stderr", ["message": text]) }
        }
        try process.run()
        self.process = process
        self.input = stdin.fileHandleForWriting
    }

    func stop() {
        if let pipe = process?.standardOutput as? Pipe { pipe.fileHandleForReading.readabilityHandler = nil }
        if process?.isRunning == true { process?.terminate() }
        process = nil
        input = nil
        outputBuffer.removeAll(keepingCapacity: false)
        let callbacks = pending.values
        pending.removeAll()
        callbacks.forEach { $0(.failure(ClientError.notRunning)) }
    }

    func request(method: String, params: [String: Any] = [:], completion: @escaping (Result<Any, Error>) -> Void) {
        guard let input else {
            completion(.failure(ClientError.notRunning))
            return
        }
        let id = nextID
        nextID += 1
        pending[id] = completion
        do {
            let data = try JSONSerialization.data(withJSONObject: [
                "jsonrpc": "2.0", "id": id, "method": method, "params": params,
            ])
            input.write(data + Data([0x0A]))
        } catch {
            pending.removeValue(forKey: id)
            completion(.failure(error))
        }
    }

    private func receive(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            do {
                guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                    throw ClientError.invalidResponse
                }
                if let method = object["method"] as? String {
                    onNotification?(method, object["params"] as? [String: Any] ?? [:])
                } else if let id = object["id"] as? Int, let callback = pending.removeValue(forKey: id) {
                    if let error = object["error"] as? [String: Any] {
                        callback(.failure(ClientError.server(error["message"] as? String ?? "RPC error")))
                    } else {
                        callback(.success(object["result"] as Any))
                    }
                }
            } catch {
                onTermination?(error.localizedDescription)
            }
        }
    }
}
