// IFileOpenDialog Folder Picker - 现代化文件夹选择对话框
// 使用 Windows Vista+ IFileOpenDialog COM 接口
using System;
using System.Runtime.InteropServices;

namespace FolderPicker
{
    public static class Dialog
    {
        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogRCW { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes();
            void SetFileTypeIndex();
            void GetFileTypeIndex();
            void Advise();
            void Unadvise();
            void SetOptions(FOS fos);
            void GetOptions(out FOS pfos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([In, MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([In, MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel();
            void SetFileNameLabel();
            void GetResult(out IShellItem ppsi);
            void AddPlace(IShellItem psi, int alignment);
            void SetDefaultExtension();
            void Close();
            void SetClientGuid();
            void ClearClientData();
            void SetFilter();
            void GetResults();
            void GetSelectedItems();
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler();
            void GetParent();
            void GetDisplayName(SIGDN sigdnName,
                [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            void GetAttributes();
            void Compare();
        }

        [Flags]
        private enum FOS : uint
        {
            FOS_PICKFOLDERS = 0x00000020,
            FOS_FORCEFILESYSTEM = 0x00000040,
            FOS_DONTADDTORECENT = 0x02000000,
        }

        private enum SIGDN : uint
        {
            SIGDN_FILESYSPATH = 0x80058000
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            out IShellItem ppv);

        public static string PickFolder(string title, string initialPath)
        {
            try
            {
                var clsid = new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");
                var dialog = (IFileOpenDialog)Activator.CreateInstance(
                    Type.GetTypeFromCLSID(clsid));

                dialog.SetTitle(title);

                if (!string.IsNullOrEmpty(initialPath))
                {
                    IShellItem initialItem;
                    int hr = SHCreateItemFromParsingName(
                        initialPath, IntPtr.Zero,
                        typeof(IShellItem).GUID, out initialItem);
                    if (hr == 0)
                        dialog.SetFolder(initialItem);
                }

                FOS options;
                dialog.GetOptions(out options);
                options |= FOS.FOS_PICKFOLDERS;
                options |= FOS.FOS_FORCEFILESYSTEM;
                options |= FOS.FOS_DONTADDTORECENT;
                dialog.SetOptions(options);

                int result = dialog.Show(IntPtr.Zero);
                if (result == 0)
                {
                    IShellItem selected;
                    dialog.GetResult(out selected);
                    string selectedPath;
                    selected.GetDisplayName(
                        SIGDN.SIGDN_FILESYSPATH, out selectedPath);
                    return selectedPath;
                }
                return null;
            }
            catch
            {
                return null;
            }
        }
    }
}
