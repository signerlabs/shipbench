import SwiftUI

/// Sign-in screen, shown when nobody is signed in.
struct SignInView: View {
    @State private var isSigningIn = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "leaf.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)
            Text("Sprout")
                .font(.largeTitle.bold())
            Text("Small habits, every day.")
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                isSigningIn = true
                Task {
                    defer { isSigningIn = false }
                    try? await AuthStore.shared.signIn()
                }
            } label: {
                Text("Sign In")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isSigningIn)
        }
        .padding()
    }
}
